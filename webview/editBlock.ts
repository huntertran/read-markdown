// In-preview editing of top-level blocks as raw Markdown source. A block (element with
// `data-line-end`) is swapped for a textarea holding its exact source lines, fetched from the
// extension; saving sends the text back, and the extension replaces those lines with a
// WorkspaceEdit (undoable, version-checked). Renders arriving while a block is open are held back
// so they do not wipe the textarea, then applied when it closes.
import type { EditError, ToWebview } from '../src/protocol';
import { post } from './api';
import { hideBlockActions, registerBlockAction } from './blockActions';
import { invalidate, scrollProgrammatically } from './scroll';

type RenderMessage = Extract<ToWebview, { type: 'render' }>;

interface Options {
  content: HTMLElement;
  /** `docVersion` of the render currently shown (the one block line numbers refer to). */
  docVersion: () => number | undefined;
  render: (msg: RenderMessage) => void;
}

interface Session {
  block: HTMLElement;
  editor: HTMLElement;
  textarea: HTMLTextAreaElement;
  notice: HTMLElement;
  start: number;
  end: number;
  docVersion: number;
  original: string;
  saving: boolean;
}

const MESSAGES: Record<EditError, string> = {
  stale: 'The file changed since this block was opened. Copy your text if you need it, then Cancel to reload the preview.',
  readonly: 'This document is read-only.',
  invalid: 'This block no longer matches the source. Cancel and try again.',
  failed: 'VS Code could not apply the edit.',
};
const OPEN_MESSAGES: Record<EditError, string> = {
  ...MESSAGES,
  stale: 'The preview is updating. Try again in a moment.',
};

const TASK_CLASS = 'task-list-item-checkbox';
const isMac =/Mac|iPhone|iPad/.test(navigator.platform);

let opts: Options;
let enabled = false;
let doubleClick = false;
let session: Session | undefined;
let request: { block: HTMLElement; start: number; end: number } | undefined;
let pendingRender: RenderMessage | undefined;
/** Task checkbox whose toggle is waiting for the extension's `taskResult`. */
let pendingTask: { line: number; input: HTMLInputElement } | undefined;

export function initBlockEdit(options: Options): void {
  opts = options;
  // Primary action, so it gets a rail button rather than a menu item.
  registerBlockAction({
    id: 'edit',
    label: 'Edit this block',
    icon: '✎',
    placement: 'rail',
    when: () => enabled && !session,
    run: startEdit,
  });

  // Task list checkboxes toggle in place instead of opening the block editor.
  opts.content.addEventListener('click', (e) => {
    const target = e.target as Element;
    if (!(target instanceof HTMLInputElement && target.classList.contains(TASK_CLASS))) {
      // The renderer wraps each checkbox in a <label>; clicking the item text must not toggle it.
      if (enabled && !target.closest('a') && target.closest('label')?.querySelector(`:scope > input.${TASK_CLASS}`)) e.preventDefault();
      return;
    }
    const line = Number(target.closest<HTMLElement>('li.task-list-item')?.dataset.line);
    const docVersion = opts.docVersion();
    // One toggle at a time: the next one needs the document version this one produces.
    if (!enabled || session || pendingTask || !Number.isInteger(line) || docVersion === undefined) {
      e.preventDefault();
      return;
    }
    pendingTask = { line, input: target };
    target.classList.add('rm-task-pending');
    post({ type: 'toggleTask', line, checked: target.checked, docVersion });
  });

  opts.content.addEventListener('dblclick', (e) => {
    if (!enabled || !doubleClick) return;
    const target = e.target as Element;
    // Links and controls keep their own double-click behaviour.
    if (target.closest('a, button, input, summary, .rm-edit')) return;
    const block = findBlock(target);
    if (!block) return;
    window.getSelection()?.removeAllRanges();
    startEdit(block);
  });
}

/** True while a block is open in the editor. */
export function isEditing(): boolean {
  return session !== undefined;
}

/** Opens the top-level block starting at source `line` (context menu → Edit Block). */
export function editBlockAtLine(line: number): void {
  if (!enabled) return;
  const block = opts.content.querySelector<HTMLElement>(`[data-line-end][data-line="${line}"]`);
  if (block) startEdit(block);
}

export function setEditable(value: boolean, editOnDoubleClick: boolean): void {
  enabled = value;
  doubleClick = value && editOnDoubleClick;
  syncTaskCheckboxes();
  if (!enabled) {
    if (session && !session.saving) close();
  }
}

/** Call after each render: task checkboxes are clickable only while editing is enabled. */
export function syncTaskCheckboxes(): void {
  pendingTask = undefined;
  for (const input of opts.content.querySelectorAll<HTMLInputElement>(`input.${TASK_CLASS}`)) {
    input.disabled = !enabled;
    input.title = enabled ? (input.checked ? 'Mark as not done' : 'Mark as done') : '';
  }
}

export function onTaskResult(msg: Extract<ToWebview, { type: 'taskResult' }>): void {
  const task = pendingTask;
  if (!task || task.line !== msg.line) return;
  pendingTask = undefined;
  // On success the extension has already sent the re-render with the new state.
  if (msg.ok || !task.input.isConnected) return;
  task.input.checked = !task.input.checked;
  task.input.classList.remove('rm-task-pending');
  flash(task.input.closest<HTMLElement>('[data-line-end]') ?? task.input, OPEN_MESSAGES[msg.error ?? 'failed']);
}

function findBlock(target: Element): HTMLElement | undefined {
  const block = target.closest<HTMLElement>('[data-line-end]');
  if (!block || !opts.content.contains(block) || block.closest('.rm-edit')) return undefined;
  return block;
}

// ---- render deferral -----------------------------------------------------------------------

/** Call before applying a render. Returns true if the render was held back for an open editor. */
export function deferRender(msg: RenderMessage): boolean {
  if (!session) {
    pendingRender = undefined;
    return false;
  }
  if (!pendingRender || msg.docVersion >= pendingRender.docVersion) pendingRender = msg;
  if (msg.docVersion !== session.docVersion && !session.saving) showNotice(MESSAGES.stale);
  return true;
}

// ---- edit session --------------------------------------------------------------------------

function startEdit(block: HTMLElement): void {
  hideBlockActions();
  if (session) {
    session.textarea.focus();
    return;
  }
  const start = Number(block.dataset.line);
  const end = Number(block.dataset.lineEnd);
  const docVersion = opts.docVersion();
  if (!Number.isInteger(start) || !Number.isInteger(end) || docVersion === undefined) return;
  request = { block, start, end };
  post({ type: 'requestBlockSource', start, end, docVersion });
}

export function onBlockSource(msg: Extract<ToWebview, { type: 'blockSource' }>): void {
  const req = request;
  if (!req || req.start !== msg.start || req.end !== msg.end) return;
  request = undefined;
  if (session || !req.block.isConnected || msg.docVersion !== opts.docVersion()) return;
  if (msg.error || msg.text === undefined) {
    flash(req.block, OPEN_MESSAGES[msg.error ?? 'failed']);
    return;
  }
  open(req.block, msg.start, msg.end, msg.docVersion, msg.text);
}

function open(block: HTMLElement, start: number, end: number, docVersion: number, text: string): void {
  const editor = document.createElement('div');
  editor.className = 'rm-edit';
  // Keep the block's source line so scroll sync still maps this position.
  editor.dataset.line = String(start);

  const textarea = document.createElement('textarea');
  textarea.className = 'rm-edit-input';
  textarea.spellcheck = false;
  textarea.value = text;
  textarea.setAttribute('aria-label', `Markdown source, lines ${start + 1}–${end}`);

  const notice = document.createElement('div');
  notice.className = 'rm-edit-notice';
  notice.setAttribute('role', 'alert');
  notice.hidden = true;

  const bar = document.createElement('div');
  bar.className = 'rm-edit-bar';
  const hint = document.createElement('span');
  hint.className = 'rm-edit-hint';
  hint.textContent = `${isMac ? '⌘' : 'Ctrl'}+Enter to save · Esc to cancel`;
  const cancel = button('Cancel', 'rm-edit-cancel', () => close());
  const save = button('Save', 'rm-edit-save', () => commit());
  bar.append(hint, cancel, save);

  editor.append(textarea, notice, bar);
  const height = block.getBoundingClientRect().height;
  block.replaceWith(editor);
  session = { block, editor, textarea, notice, start, end, docVersion, original: text, saving: false };

  textarea.style.minHeight = `${Math.max(60, Math.round(height))}px`;
  autosize(textarea);
  textarea.addEventListener('input', () => autosize(textarea));
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  textarea.focus({ preventScroll: true });
  invalidate();
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

/** Grows the textarea with its content without jumping the page scroll position. */
function autosize(textarea: HTMLTextAreaElement): void {
  const y = window.scrollY;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
  if (window.scrollY !== y) scrollProgrammatically(y);
  invalidate();
}

function commit(): void {
  const s = session;
  if (!s || s.saving) return;
  if (s.textarea.value === s.original) {
    close();
    return;
  }
  s.saving = true;
  s.textarea.readOnly = true;
  s.editor.classList.add('rm-edit-saving');
  showNotice(undefined);
  post({ type: 'editBlock', start: s.start, end: s.end, docVersion: s.docVersion, text: s.textarea.value });
}

export function onEditResult(msg: Extract<ToWebview, { type: 'editResult' }>): void {
  const s = session;
  if (!s || !s.saving || s.start !== msg.start || s.end !== msg.end) return;
  if (msg.ok) {
    close();
    return;
  }
  s.saving = false;
  s.textarea.readOnly = false;
  s.editor.classList.remove('rm-edit-saving');
  showNotice(MESSAGES[msg.error ?? 'failed']);
  s.textarea.focus({ preventScroll: true });
}

/** Closes the editor: applies the newest held-back render, or puts the original block back. */
function close(): void {
  const s = session;
  if (!s) return;
  session = undefined;
  const next = pendingRender;
  pendingRender = undefined;
  if (next) {
    opts.render(next);
  } else {
    s.editor.replaceWith(s.block);
    invalidate();
  }
}

function showNotice(text: string | undefined): void {
  if (!session) return;
  session.notice.hidden = !text;
  session.notice.textContent = text ?? '';
}

/** Short-lived message under a block that could not be opened for editing. */
function flash(block: HTMLElement, text: string): void {
  const note = document.createElement('div');
  note.className = 'rm-edit-flash';
  note.setAttribute('role', 'status');
  note.textContent = text;
  block.after(note);
  setTimeout(() => note.remove(), 4000);
}
