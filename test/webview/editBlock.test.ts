import * as assert from 'node:assert/strict';
import type { EditError, ToWebview } from '../../src/protocol';
import { createMarkdownRenderer } from '../../src/render/markdown';
import { useDom } from './dom';
import { useVsCodeApi } from './vscodeApi';

// editBlock.ts pulls in api.ts (calls acquireVsCodeApi at import), scroll.ts (window listeners at
// import) and listDrag.ts (window.matchMedia at import), so everything is loaded after the DOM and
// the host API stub exist.
type EditBlock = typeof import('../../webview/editBlock');
type BlockActions = typeof import('../../webview/blockActions');
type Sanitize = typeof import('../../webview/sanitize');
type RenderMessage = Extract<ToWebview, { type: 'render' }>;

const ERRORS: EditError[] = ['stale', 'readonly', 'invalid', 'failed'];

// Copies of the user-visible texts in editBlock.ts (they are not exported).
const MESSAGES: Record<EditError, string> = {
  stale: 'The file changed since this block was opened. Copy your text if you need it, then Cancel to reload the preview.',
  readonly: 'This document is read-only.',
  invalid: 'This block no longer matches the source. Cancel and try again.',
  failed: 'VS Code could not apply the edit.',
};
const OPEN_MESSAGES: Record<EditError, string> = { ...MESSAGES, stale: 'The preview is updating. Try again in a moment.' };

// Source lines (0-based): heading 0, paragraph 2, task list 4-6 (blank line 6 belongs to it),
// raw HTML block 7.
const DOC = ['# Title', '', 'para with **bold** text', '', '- [ ] one', '- [x] two', '', '<div>raw</div>', ''].join('\n');
const HEADING = 0;
const PARA = 2;
const LIST = 4;
const RAW = 7;

describe('block edit session', () => {
  // `navigator`: editBlock.ts reads `navigator.platform` at import time. Node has its own (which says
  // 'MacIntel' on a Mac), so the jsdom one (platform '') is installed to make the non-Mac path
  // deterministic on every host.
  useDom({ globals: ['navigator'] });
  const vscode = useVsCodeApi();

  const render = createMarkdownRenderer();
  let edit: EditBlock;
  let actions: BlockActions;
  let sanitize: Sanitize['sanitize'];
  let content: HTMLElement;
  let rail: HTMLElement;
  let menu: HTMLElement;
  let version: number | undefined;
  const renders: RenderMessage[] = [];

  // setTimeout is replaced for each test so `flash` notices (removed after 4 s) do not hold the
  // process and their removal can be triggered on demand.
  const realTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map<number, () => void>();
  let timerId = 0;

  before(async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    edit = await import('../../webview/editBlock');
    actions = await import('../../webview/blockActions');
    ({ sanitize } = await import('../../webview/sanitize'));

    content = document.createElement('div');
    document.body.append(content);
    actions.initBlockActions(content);
    rail = document.querySelector<HTMLElement>('.rm-block-rail')!;
    menu = document.querySelector<HTMLElement>('.rm-block-menu')!;
    edit.initBlockEdit({ content, docVersion: () => version, render: (msg) => renders.push(msg) });
  });

  beforeEach(() => {
    // useDom's beforeEach has emptied <body>; put the persistent elements back.
    document.body.append(rail, menu, content);
    content.replaceChildren();
    version = 7;
    renders.length = 0;
    timers.clear();
    globalThis.setTimeout = ((fn: () => void) => {
      timers.set(++timerId, fn);
      return timerId;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realTimers.setTimeout;
    globalThis.clearTimeout = realTimers.clearTimeout;
    // Leave the module in its initial state for the next test.
    actions.setBlockActionsEnabled(false);
    if (edit.isEditing()) {
      edit.setEditable(false, false);
      if (edit.isEditing()) {
        // Still saving: finish the save.
        const sent = vscode.postedOfType('editBlock').at(-1);
        if (sent) edit.onEditResult({ type: 'editResult', start: sent.start, end: sent.end, ok: true });
      }
    }
    edit.setEditable(false, false);
    assert.equal(edit.isEditing(), false, 'test left an edit session open');
  });

  // ---- helpers ------------------------------------------------------------------------------

  /** Renders `markdown` the way main.ts does (real renderer + sanitize) into the preview root. */
  function load(markdown: string = DOC): void {
    content.replaceChildren(sanitize(render(markdown, { mermaid: true }).html));
    edit.syncTaskCheckboxes();
  }

  const block = (line: number): HTMLElement => {
    const el = content.querySelector<HTMLElement>(`[data-line-end][data-line="${line}"]`);
    assert.ok(el, `no block at line ${line}`);
    return el;
  };
  const textarea = (): HTMLTextAreaElement | null => content.querySelector('textarea.rm-edit-input');
  const notice = (): HTMLElement => content.querySelector<HTMLElement>('.rm-edit-notice')!;
  const flashes = (): HTMLElement[] => [...content.querySelectorAll<HTMLElement>('.rm-edit-flash')];
  const checkboxes = (): HTMLInputElement[] => [...content.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')];
  const saves = () => vscode.postedOfType('editBlock');
  const toggles = () => vscode.postedOfType('toggleTask');

  function reply(start: number, end: number, text: string, extra: { docVersion?: number } = {}): void {
    edit.onBlockSource({ type: 'blockSource', start, end, docVersion: extra.docVersion ?? version!, text });
  }

  /** Opens the editor on the block at `line` through the whole request/reply round trip. */
  function openAt(line: number, text?: string): HTMLTextAreaElement {
    edit.setEditable(true, false);
    const el = block(line);
    const start = Number(el.dataset.line);
    const end = Number(el.dataset.lineEnd);
    edit.editBlockAtLine(line);
    reply(start, end, text ?? `source of ${line}`);
    const area = textarea();
    assert.ok(area, 'editor did not open');
    return area;
  }

  function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
    const e = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  }
  const ctrlEnter = (target: Element) => key(target, { key: 'Enter', ctrlKey: true });
  const mouse = (target: Element, type: string): MouseEvent => {
    const e = new window.MouseEvent(type, { bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  const renderMsg = (docVersion: number): RenderMessage => ({ type: 'render', html: `<p>v${docVersion}</p>`, headings: [], hasMermaid: false, docVersion });
  const click = (selector: string, scope: ParentNode = content): void => {
    const el = scope.querySelector<HTMLElement>(selector);
    assert.ok(el, `no ${selector}`);
    el.click();
  };
  function runTimers(): void {
    const pending = [...timers.values()];
    timers.clear();
    for (const fn of pending) fn();
  }

  // ---- opening ------------------------------------------------------------------------------

  describe('opening', () => {
    it('editBlockAtLine posts requestBlockSource with the block range and the current docVersion', () => {
      load();
      edit.setEditable(true, false);
      version = 12;
      edit.editBlockAtLine(PARA);
      assert.deepEqual(vscode.posted, [{ type: 'requestBlockSource', start: 2, end: 3, docVersion: 12 }]);
      assert.equal(edit.isEditing(), false, 'editing starts only when the source arrives');
      assert.equal(textarea(), null);
    });

    it('editBlockAtLine posts nothing while edit is off', () => {
      load();
      edit.editBlockAtLine(PARA);
      assert.deepEqual(vscode.posted, []);
    });

    it('editBlockAtLine posts nothing for a line that starts no top-level block', () => {
      load();
      edit.setEditable(true, false);
      edit.editBlockAtLine(3); // blank line between blocks
      edit.editBlockAtLine(5); // a list item has data-line but is not a top-level block
      assert.deepEqual(vscode.posted, []);
    });

    it('posts nothing while the shown render has no docVersion yet', () => {
      load();
      edit.setEditable(true, false);
      version = undefined;
      edit.editBlockAtLine(PARA);
      assert.deepEqual(vscode.posted, []);
    });

    it('the rail button of the edit action starts the edit', () => {
      load();
      edit.setEditable(true, false);
      actions.setBlockActionsEnabled(true);
      mouse(block(PARA), 'mouseover');
      assert.equal(rail.hidden, false);
      click('.rm-block-action[data-action="edit"]', rail);
      assert.deepEqual(vscode.posted, [{ type: 'requestBlockSource', start: 2, end: 3, docVersion: 7 }]);
      assert.equal(rail.hidden, true, 'the rail is hidden before the editor opens');
    });

    it('offers no edit rail button while edit is off', () => {
      load();
      actions.setBlockActionsEnabled(true);
      mouse(block(PARA), 'mouseover');
      assert.equal(rail.hidden, true);
    });

    it('offers no edit rail button on a raw HTML block', () => {
      load();
      edit.setEditable(true, false);
      actions.setBlockActionsEnabled(true);
      mouse(block(RAW), 'mouseover');
      assert.equal(rail.hidden, true);
      mouse(block(PARA), 'mouseover');
      assert.equal(rail.hidden, false, 'a regular block still gets the rail');
      assert.ok(rail.querySelector('[data-action="edit"]'));
    });

    it('offers no edit rail button while another block is being edited', () => {
      load();
      openAt(PARA);
      actions.setBlockActionsEnabled(true);
      mouse(block(HEADING), 'mouseover');
      assert.equal(rail.hidden, true);
    });

    it('double-click starts the edit when edit.doubleClick is on', () => {
      load();
      edit.setEditable(true, true);
      mouse(content.querySelector('strong')!, 'dblclick'); // text inside the block, not the block itself
      assert.deepEqual(vscode.posted, [{ type: 'requestBlockSource', start: 2, end: 3, docVersion: 7 }]);
    });

    it('onBlockSource swaps the block for a textarea holding the source', () => {
      load();
      edit.setEditable(true, false);
      const para = block(PARA);
      edit.editBlockAtLine(PARA);
      reply(2, 3, 'para with **bold** text');

      assert.equal(edit.isEditing(), true);
      assert.equal(para.isConnected, false);
      const area = textarea()!;
      assert.equal(area.value, 'para with **bold** text');
      assert.equal(area.getAttribute('aria-label'), 'Markdown source, lines 3–3');
      assert.equal(document.activeElement, area);
      const editor = area.closest<HTMLElement>('.rm-edit')!;
      assert.equal(editor.dataset.line, '2', 'the editor keeps the block line for scroll sync');
      assert.equal(editor.previousElementSibling, block(HEADING));
      assert.equal(notice().hidden, true);
      assert.equal(editor.querySelector('.rm-edit-hint')?.textContent, 'Ctrl+Enter to save · Esc to cancel');
    });

    it('drops a reply for another range', () => {
      load();
      edit.setEditable(true, false);
      edit.editBlockAtLine(PARA);
      reply(2, 4, 'x');
      reply(0, 3, 'x');
      assert.equal(edit.isEditing(), false);
      assert.equal(block(PARA).isConnected, true);
      // The request is still waiting: the matching reply opens it.
      reply(2, 3, 'x');
      assert.equal(edit.isEditing(), true);
    });

    it('drops a reply for another docVersion', () => {
      load();
      edit.setEditable(true, false);
      edit.editBlockAtLine(PARA);
      reply(2, 3, 'x', { docVersion: 6 });
      assert.equal(edit.isEditing(), false);
      assert.equal(textarea(), null);
      assert.deepEqual(flashes(), [], 'a version mismatch is silent');
    });

    it('drops a reply that was never requested', () => {
      load();
      edit.setEditable(true, false);
      reply(2, 3, 'x');
      assert.equal(edit.isEditing(), false);
    });

    it('drops a reply when the render replaced the block in the meantime', () => {
      load();
      edit.setEditable(true, false);
      edit.editBlockAtLine(PARA);
      load(); // a new render: the requested element is gone
      reply(2, 3, 'x');
      assert.equal(edit.isEditing(), false);
      assert.equal(textarea(), null);
    });

    it('only the newest request is answered', () => {
      load();
      edit.setEditable(true, false);
      edit.editBlockAtLine(PARA);
      edit.editBlockAtLine(HEADING);
      reply(2, 3, 'para source');
      assert.equal(edit.isEditing(), false, 'the reply for the first request is ignored');
      reply(0, 1, '# Title');
      assert.equal(textarea()?.value, '# Title');
    });

    for (const error of ERRORS) {
      it(`shows the open message for a "${error}" reply and does not open an editor`, () => {
        load();
        edit.setEditable(true, false);
        const para = block(PARA);
        edit.editBlockAtLine(PARA);
        edit.onBlockSource({ type: 'blockSource', start: 2, end: 3, docVersion: 7, error });
        assert.equal(edit.isEditing(), false);
        const [note] = flashes();
        assert.equal(note.textContent, OPEN_MESSAGES[error]);
        assert.equal(note.getAttribute('role'), 'status');
        assert.equal(para.nextElementSibling, note, 'the message sits under the block');
        assert.equal(para.isConnected, true);
        runTimers();
        assert.deepEqual(flashes(), [], 'the message goes away by itself');
      });
    }

    it('treats a reply with neither text nor error as a failure', () => {
      load();
      edit.setEditable(true, false);
      edit.editBlockAtLine(PARA);
      edit.onBlockSource({ type: 'blockSource', start: 2, end: 3, docVersion: 7 });
      assert.equal(flashes()[0].textContent, OPEN_MESSAGES.failed);
      assert.equal(edit.isEditing(), false);
    });

    it('asking again while an editor is open posts nothing and refocuses it', () => {
      load();
      const area = openAt(PARA);
      vscode.clear();
      (document.activeElement as HTMLElement).blur();
      edit.editBlockAtLine(HEADING);
      assert.deepEqual(vscode.posted, []);
      assert.equal(document.activeElement, area);
    });

    it('never opens a raw HTML block: not through editBlockAtLine', () => {
      load();
      edit.setEditable(true, false);
      assert.equal(block(RAW).hasAttribute('data-rm-html'), true, 'fixture: the renderer flags the block');
      edit.editBlockAtLine(RAW);
      assert.deepEqual(vscode.posted, []);
      assert.equal(edit.isEditing(), false);
    });
  });

  // ---- render deferral ----------------------------------------------------------------------

  describe('deferRender', () => {
    it('does not hold a render when no editor is open', () => {
      load();
      assert.equal(edit.deferRender(renderMsg(8)), false);
      assert.equal(renders.length, 0);
    });

    it('holds renders while an editor is open and applies the newest one on close, once', () => {
      load();
      const area = openAt(PARA);
      assert.equal(edit.deferRender(renderMsg(8)), true);
      assert.equal(edit.deferRender(renderMsg(10)), true);
      assert.equal(edit.deferRender(renderMsg(9)), true, 'an older render is held back too, but does not replace the newer one');
      assert.equal(renders.length, 0, 'nothing is applied while the editor is open');
      assert.equal(textarea(), area, 'the textarea survives');

      key(area, { key: 'Escape' });
      assert.deepEqual(renders.map((r) => r.docVersion), [10]);
      assert.equal(edit.isEditing(), false);
      assert.equal(edit.deferRender(renderMsg(11)), false, 'the editor is closed: not held any more');
      assert.deepEqual(renders.map((r) => r.docVersion), [10], 'the held render is not applied a second time');
    });

    it('of two renders with the same docVersion the later one wins', () => {
      load();
      const area = openAt(PARA);
      const first = { ...renderMsg(8), html: '<p>first</p>' };
      const second = { ...renderMsg(8), html: '<p>second</p>' };
      edit.deferRender(first);
      edit.deferRender(second);
      key(area, { key: 'Escape' });
      assert.deepEqual(renders, [second]);
    });

    it('shows the stale notice when the render is for another version than the open block', () => {
      load();
      openAt(PARA); // opened at version 7
      assert.equal(notice().hidden, true);
      assert.equal(edit.deferRender(renderMsg(7)), true);
      assert.equal(notice().hidden, true, 'the same version is not stale');
      assert.equal(edit.deferRender(renderMsg(8)), true);
      assert.equal(notice().hidden, false);
      assert.equal(notice().textContent, MESSAGES.stale);
      assert.equal(notice().getAttribute('role'), 'alert');
    });

    it('holds the render without a notice while the edit is being saved', () => {
      load();
      const area = openAt(PARA);
      area.value = 'changed';
      ctrlEnter(area);
      assert.equal(saves().length, 1);
      assert.equal(edit.deferRender(renderMsg(8)), true, 'still held: the editor is open until the result arrives');
      assert.equal(notice().hidden, true, 'no stale notice while saving');
      assert.equal(renders.length, 0);

      edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: true });
      assert.deepEqual(renders.map((r) => r.docVersion), [8], 'applied when the save finishes');
    });

    it('keeps the held render across a failed save and applies it when the editor is cancelled', () => {
      load();
      const area = openAt(PARA);
      area.value = 'changed';
      ctrlEnter(area);
      assert.equal(edit.deferRender(renderMsg(8)), true);
      edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: false, error: 'stale' });
      assert.equal(renders.length, 0);
      assert.equal(area.value, 'changed');
      key(area, { key: 'Escape' });
      assert.deepEqual(renders.map((r) => r.docVersion), [8]);
    });

    it('closing with a held render leaves the DOM to the render; without one it puts the block back', () => {
      load();
      const para = block(PARA);
      let area = openAt(PARA);
      assert.equal(edit.deferRender(renderMsg(8)), true);
      key(area, { key: 'Escape' });
      assert.equal(para.isConnected, false, 'the original block is not restored over the newer render');
      assert.equal(renders.length, 1);

      load();
      const again = block(PARA);
      area = openAt(PARA);
      assert.equal(again.isConnected, false);
      key(area, { key: 'Escape' });
      assert.equal(renders.length, 1, 'no render was held');
      assert.equal(textarea(), null);
      assert.equal(block(PARA), again);
    });

    it('a held render does not outlive a session that ended without it being applied', () => {
      load();
      const area = openAt(PARA);
      assert.equal(edit.deferRender(renderMsg(8)), true);
      key(area, { key: 'Escape' });
      assert.equal(renders.length, 1);
      // A new session: nothing from before is applied when it closes.
      load();
      const next = openAt(PARA);
      key(next, { key: 'Escape' });
      assert.equal(renders.length, 1);
    });
  });

  // ---- commit and cancel --------------------------------------------------------------------

  describe('commit and cancel', () => {
    it('Ctrl+Enter with unchanged text closes without posting editBlock', () => {
      load();
      const para = block(PARA);
      const area = openAt(PARA, 'same');
      const e = ctrlEnter(area);
      assert.equal(e.defaultPrevented, true);
      assert.deepEqual(saves(), []);
      assert.equal(edit.isEditing(), false);
      assert.equal(textarea(), null);
      assert.equal(block(PARA), para, 'the original block is back');
    });

    it('Ctrl+Enter with changed text posts editBlock for the opened range and version, and locks the textarea', () => {
      load();
      version = 3;
      const area = openAt(PARA, 'old');
      version = 4; // the preview moved on; the edit still targets what was opened
      area.value = 'new text\nsecond line';
      const e = ctrlEnter(area);
      assert.equal(e.defaultPrevented, true);
      assert.deepEqual(saves(), [{ type: 'editBlock', start: 2, end: 3, docVersion: 3, text: 'new text\nsecond line' }]);
      assert.equal(area.readOnly, true);
      assert.equal(area.closest('.rm-edit')!.classList.contains('rm-edit-saving'), true);
      assert.equal(edit.isEditing(), true, 'stays open until the result arrives');
      assert.equal(notice().hidden, true);
    });

    it('a second Ctrl+Enter while saving posts nothing', () => {
      load();
      const area = openAt(PARA, 'old');
      area.value = 'new';
      ctrlEnter(area);
      ctrlEnter(area);
      click('.rm-edit-save');
      assert.equal(saves().length, 1);
    });

    it('Enter alone and Cmd+Enter (not a Mac) do not save', () => {
      load();
      const area = openAt(PARA, 'old');
      area.value = 'new';
      const plain = key(area, { key: 'Enter' });
      const meta = key(area, { key: 'Enter', metaKey: true });
      assert.deepEqual(saves(), []);
      assert.equal(plain.defaultPrevented, false, 'Enter still types a newline');
      assert.equal(meta.defaultPrevented, false);
      assert.equal(edit.isEditing(), true);
    });

    it('Esc cancels without posting, discards the text and keeps the key from bubbling', () => {
      load();
      const para = block(PARA);
      const area = openAt(PARA, 'old');
      area.value = 'typed but cancelled';
      const seen: string[] = [];
      content.addEventListener('keydown', (e) => seen.push(e.key));
      const e = key(area, { key: 'Escape' });
      assert.equal(e.defaultPrevented, true);
      assert.deepEqual(seen, [], 'Esc is not passed on (it would close other things)');
      assert.deepEqual(saves(), []);
      assert.equal(edit.isEditing(), false);
      assert.equal(block(PARA), para);
      assert.equal(block(PARA).textContent, 'para with bold text');
    });

    it('the Save button posts like Ctrl+Enter, and closes quietly when nothing changed', () => {
      load();
      openAt(PARA, 'old');
      click('.rm-edit-save');
      assert.deepEqual(saves(), []);
      assert.equal(edit.isEditing(), false);

      load();
      const area = openAt(PARA, 'old');
      area.value = 'new';
      click('.rm-edit-save');
      assert.deepEqual(saves(), [{ type: 'editBlock', start: 2, end: 3, docVersion: 7, text: 'new' }]);
    });

    it('the Cancel button closes without posting', () => {
      load();
      const area = openAt(PARA, 'old');
      area.value = 'new';
      click('.rm-edit-cancel');
      assert.deepEqual(saves(), []);
      assert.equal(edit.isEditing(), false);
      assert.equal(textarea(), null);
    });

    it('the textarea is also reachable for other blocks: range comes from the block, not the previous edit', () => {
      load();
      let area = openAt(PARA, 'p');
      area.value = 'p2';
      ctrlEnter(area);
      edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: true });
      load();
      area = openAt(LIST, 'list');
      area.value = 'list2';
      ctrlEnter(area);
      assert.deepEqual(saves().map((s) => [s.start, s.end]), [[2, 3], [4, 7]]);
    });
  });

  // ---- edit results -------------------------------------------------------------------------

  describe('onEditResult', () => {
    it('success closes the editor and restores the block when no render was held', () => {
      load();
      const para = block(PARA);
      const area = openAt(PARA, 'old');
      area.value = 'new';
      ctrlEnter(area);
      edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: true });
      assert.equal(edit.isEditing(), false);
      assert.equal(textarea(), null);
      assert.equal(block(PARA), para);
    });

    for (const error of ERRORS) {
      it(`failure "${error}" unlocks the textarea, keeps the text and shows its message`, () => {
        load();
        const area = openAt(PARA, 'old');
        area.value = 'precious unsaved text';
        ctrlEnter(area);
        (document.activeElement as HTMLElement).blur();
        edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: false, error });
        assert.equal(edit.isEditing(), true);
        assert.equal(area.readOnly, false);
        assert.equal(area.closest('.rm-edit')!.classList.contains('rm-edit-saving'), false);
        assert.equal(area.value, 'precious unsaved text');
        assert.equal(notice().hidden, false);
        assert.equal(notice().textContent, MESSAGES[error]);
        assert.equal(document.activeElement, area);
      });
    }

    it('failure without an error code shows the generic message', () => {
      load();
      const area = openAt(PARA, 'old');
      area.value = 'new';
      ctrlEnter(area);
      edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: false });
      assert.equal(notice().textContent, MESSAGES.failed);
    });

    it('after a failure the user can save again, which clears the message', () => {
      load();
      const area = openAt(PARA, 'old');
      area.value = 'new';
      ctrlEnter(area);
      edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: false, error: 'failed' });
      ctrlEnter(area);
      assert.equal(saves().length, 2);
      assert.equal(notice().hidden, true);
      assert.equal(area.readOnly, true);
    });

    it('ignores a result for another range, or one that arrives when no save is pending', () => {
      load();
      const area = openAt(PARA, 'old');
      edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: true }); // not saving yet
      assert.equal(edit.isEditing(), true);
      area.value = 'new';
      ctrlEnter(area);
      edit.onEditResult({ type: 'editResult', start: 0, end: 1, ok: true });
      edit.onEditResult({ type: 'editResult', start: 2, end: 4, ok: false, error: 'failed' });
      assert.equal(edit.isEditing(), true);
      assert.equal(area.readOnly, true, 'still saving');
      assert.equal(notice().hidden, true);
    });

    it('ignores a result when no editor is open', () => {
      load();
      edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: true });
      assert.equal(edit.isEditing(), false);
    });
  });

  // ---- setEditable and isEditing ------------------------------------------------------------

  describe('setEditable and isEditing', () => {
    it('isEditing follows the session: request, open, save, close', () => {
      load();
      edit.setEditable(true, false);
      assert.equal(edit.isEditing(), false);
      edit.editBlockAtLine(PARA);
      assert.equal(edit.isEditing(), false, 'requested');
      reply(2, 3, 'old');
      assert.equal(edit.isEditing(), true, 'open');
      const area = textarea()!;
      area.value = 'new';
      ctrlEnter(area);
      assert.equal(edit.isEditing(), true, 'saving');
      edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: true });
      assert.equal(edit.isEditing(), false, 'closed');
    });

    it('turning edit off closes an open editor and puts the block back', () => {
      load();
      const para = block(PARA);
      const area = openAt(PARA, 'old');
      area.value = 'unsaved';
      edit.setEditable(false, false);
      assert.equal(edit.isEditing(), false);
      assert.equal(textarea(), null);
      assert.equal(block(PARA), para);
    });

    it('turning edit off applies a held render', () => {
      load();
      openAt(PARA);
      edit.deferRender(renderMsg(9));
      edit.setEditable(false, false);
      assert.deepEqual(renders.map((r) => r.docVersion), [9]);
    });

    it('turning edit off does not close an editor that is saving', () => {
      load();
      const area = openAt(PARA, 'old');
      area.value = 'new';
      ctrlEnter(area);
      edit.setEditable(false, false);
      assert.equal(edit.isEditing(), true);
      assert.equal(textarea(), area);
      edit.onEditResult({ type: 'editResult', start: 2, end: 3, ok: true });
      assert.equal(edit.isEditing(), false);
    });

    it('does not open an editor for a reply that arrives after edit was turned off', () => {
      load();
      edit.setEditable(true, false);
      edit.editBlockAtLine(PARA);
      edit.setEditable(false, false);
      reply(2, 3, 'old');
      assert.equal(edit.isEditing(), false);
    });

    // A failed result must still find the editor, with the user's text, to report the failure in.
    it('keeps the editor open when Esc or Cancel is used while the save is in flight', () => {
      load();
      const area = openAt(PARA, 'old');
      area.value = 'new';
      ctrlEnter(area);
      key(area, { key: 'Escape' });
      assert.equal(edit.isEditing(), true);
      document.querySelector<HTMLButtonElement>('.rm-edit-cancel')?.click();
      assert.equal(edit.isEditing(), true);
      assert.equal(textarea(), area);
      assert.equal(area.value, 'new');
    });

    it('turning edit on (or changing the double-click option) leaves an open editor alone', () => {
      load();
      const area = openAt(PARA, 'old');
      edit.setEditable(true, true);
      assert.equal(edit.isEditing(), true);
      assert.equal(textarea(), area);
    });
  });

  // ---- task checkboxes ----------------------------------------------------------------------

  describe('task checkboxes', () => {
    /** Task-list markup inside a removed (track changes) clone. */
    function addRemovedClone(selector: string): HTMLInputElement {
      const clone = document.createElement('div');
      clone.className = selector;
      clone.innerHTML =
        '<ul class="contains-task-list"><li class="task-list-item"><label><input class="task-list-item-checkbox" type="checkbox"> gone</label></li></ul>';
      content.append(clone);
      return clone.querySelector('input')!;
    }

    it('are enabled only while edit is on, with a title that says what a click does', () => {
      load();
      const [one, two] = checkboxes();
      assert.equal(one.disabled, true);
      assert.equal(two.disabled, true);
      assert.equal(one.title, '');

      edit.setEditable(true, false);
      assert.equal(one.disabled, false);
      assert.equal(two.disabled, false);
      assert.equal(one.title, 'Mark as done');
      assert.equal(two.title, 'Mark as not done');

      edit.setEditable(false, false);
      assert.equal(one.disabled, true);
      assert.equal(one.title, '');
    });

    it('syncTaskCheckboxes enables the checkboxes of a freshly rendered DOM', () => {
      edit.setEditable(true, false);
      load();
      assert.equal(checkboxes().every((c) => !c.disabled), true);
    });

    it('stay disabled inside removed track-changes clones', () => {
      load();
      const del = addRemovedClone('rm-chg-del');
      const moved = addRemovedClone('rm-chg-move-from');
      edit.setEditable(true, false);
      assert.equal(del.disabled, true);
      assert.equal(moved.disabled, true);
      assert.equal(checkboxes().filter((c) => !c.disabled).length, 2, 'only the two live items are enabled');
    });

    it('a toggle posts toggleTask with the item line, the new state and the docVersion', () => {
      load();
      edit.setEditable(true, false);
      const [one, two] = checkboxes();
      one.click();
      assert.deepEqual(vscode.posted, [{ type: 'toggleTask', line: 4, checked: true, docVersion: 7 }]);
      assert.equal(one.checked, true, 'optimistic: the box stays checked until the result');
      assert.equal(one.classList.contains('rm-task-pending'), true);

      edit.onTaskResult({ type: 'taskResult', line: 4, ok: true });
      vscode.clear();
      two.click();
      assert.deepEqual(vscode.posted, [{ type: 'toggleTask', line: 5, checked: false, docVersion: 7 }]);
    });

    it('a second toggle while one is pending is cancelled: nothing is posted and the box is put back', () => {
      load();
      edit.setEditable(true, false);
      const [one, two] = checkboxes();
      one.click();
      two.click();
      assert.equal(toggles().length, 1);
      assert.equal(two.checked, true, 'the click was prevented, so the checkbox keeps its state');
      assert.equal(two.classList.contains('rm-task-pending'), false);
      one.click(); // the pending box itself is ignored as well
      assert.equal(toggles().length, 1);
    });

    it('a successful result lets the next toggle through and keeps the checkbox as it is', () => {
      load();
      edit.setEditable(true, false);
      const [one, two] = checkboxes();
      one.click();
      edit.onTaskResult({ type: 'taskResult', line: 4, ok: true });
      assert.equal(one.checked, true);
      assert.deepEqual(flashes(), []);
      two.click();
      assert.equal(toggles().length, 2);
    });

    it('a result for another line is ignored and the toggle stays pending', () => {
      load();
      edit.setEditable(true, false);
      const [one, two] = checkboxes();
      one.click();
      edit.onTaskResult({ type: 'taskResult', line: 5, ok: false, error: 'failed' });
      assert.equal(one.checked, true);
      assert.deepEqual(flashes(), []);
      two.click();
      assert.equal(toggles().length, 1, 'still waiting for line 4');
    });

    it('a new render (syncTaskCheckboxes) forgets the pending toggle', () => {
      load();
      edit.setEditable(true, false);
      checkboxes()[0].click();
      load();
      checkboxes()[1].click();
      assert.equal(toggles().length, 2);
    });

    for (const error of ERRORS) {
      it(`a failed result ("${error}") reverts the checkbox and flashes the message under the list`, () => {
        load();
        edit.setEditable(true, false);
        const [one] = checkboxes();
        one.click();
        assert.equal(one.checked, true);
        edit.onTaskResult({ type: 'taskResult', line: 4, ok: false, error });
        assert.equal(one.checked, false);
        assert.equal(one.classList.contains('rm-task-pending'), false);
        const [note] = flashes();
        assert.equal(note.textContent, OPEN_MESSAGES[error]);
        assert.equal(block(LIST).nextElementSibling, note);
        runTimers();
        assert.deepEqual(flashes(), []);
      });
    }

    it('a failed result without an error code reverts a checked box and flashes the generic message', () => {
      load();
      edit.setEditable(true, false);
      const [, two] = checkboxes();
      two.click(); // checked -> unchecked
      assert.equal(two.checked, false);
      edit.onTaskResult({ type: 'taskResult', line: 5, ok: false });
      assert.equal(two.checked, true);
      assert.equal(flashes()[0].textContent, OPEN_MESSAGES.failed);
    });

    it('a failed result after the checkbox left the DOM does nothing', () => {
      load();
      edit.setEditable(true, false);
      checkboxes()[0].click();
      content.replaceChildren();
      edit.onTaskResult({ type: 'taskResult', line: 4, ok: false, error: 'failed' });
      assert.deepEqual(flashes(), []);
    });

    it('a click on the item text does not toggle the checkbox', () => {
      load();
      edit.setEditable(true, false);
      const [one] = checkboxes();
      const label = one.closest('label')!;
      label.click();
      assert.equal(one.checked, false);
      assert.deepEqual(toggles(), []);
      assert.equal(one.classList.contains('rm-task-pending'), false);
    });

    it('does not prevent a click on a link inside the item text', () => {
      load('- [ ] see [the docs](#docs)\n');
      edit.setEditable(true, false);
      const link = content.querySelector('a')!;
      const e = mouse(link, 'click');
      assert.equal(e.defaultPrevented, false);
      assert.deepEqual(toggles(), []);
    });

    it('is ignored while a block editor is open', () => {
      load();
      edit.setEditable(true, false);
      const [one] = checkboxes();
      openAt(PARA);
      one.click();
      assert.deepEqual(toggles(), []);
      assert.equal(one.checked, false);
    });

    it('is ignored while the shown render has no docVersion', () => {
      load();
      edit.setEditable(true, false);
      version = undefined;
      const [one] = checkboxes();
      one.click();
      assert.deepEqual(toggles(), []);
      assert.equal(one.checked, false);
    });
  });

  // ---- double-click -------------------------------------------------------------------------

  describe('double-click', () => {
    it('does nothing unless edit.doubleClick is on', () => {
      load();
      edit.setEditable(true, false);
      mouse(block(PARA), 'dblclick');
      assert.deepEqual(vscode.posted, []);
    });

    it('does nothing while edit is off, even if the double-click option is passed', () => {
      load();
      edit.setEditable(false, true);
      mouse(block(PARA), 'dblclick');
      assert.deepEqual(vscode.posted, []);
    });

    it('starts the edit of the block under the pointer and clears the text selection', () => {
      load();
      edit.setEditable(true, true);
      const selection = window.getSelection()!;
      selection.selectAllChildren(block(PARA));
      assert.equal(selection.rangeCount, 1);
      mouse(block(HEADING), 'dblclick');
      assert.deepEqual(vscode.posted, [{ type: 'requestBlockSource', start: 0, end: 1, docVersion: 7 }]);
      assert.equal(selection.rangeCount, 0);
    });

    it('leaves double-clicks on links, buttons, inputs, summaries and inside an editor alone', () => {
      edit.setEditable(true, true);
      const host = document.createElement('div');
      host.dataset.line = '0';
      host.dataset.lineEnd = '3';
      host.innerHTML =
        '<a href="#x">link</a><button type="button">btn</button><input type="checkbox">' +
        '<details><summary>sum</summary>body</details><span class="rm-edit"><em>inside</em></span><span class="plain">text</span>';
      content.append(host);
      for (const selector of ['a', 'button', 'input', 'summary', '.rm-edit', '.rm-edit em']) {
        mouse(host.querySelector(selector)!, 'dblclick');
        assert.deepEqual(vscode.posted, [], `${selector} must keep its own double-click`);
      }
      mouse(host.querySelector('.plain')!, 'dblclick');
      assert.deepEqual(vscode.posted, [{ type: 'requestBlockSource', start: 0, end: 3, docVersion: 7 }]);
    });

    it('does not edit a link inside a real rendered block', () => {
      load('see [docs](#docs) here\n');
      edit.setEditable(true, true);
      mouse(content.querySelector('a')!, 'dblclick');
      assert.deepEqual(vscode.posted, []);
    });

    it('never edits a raw HTML block', () => {
      load();
      edit.setEditable(true, true);
      mouse(block(RAW), 'dblclick');
      assert.deepEqual(vscode.posted, []);
    });

    it('never edits a raw HTML block, also from an element nested in it', () => {
      load('<div><span>inner</span></div>\n');
      edit.setEditable(true, true);
      assert.equal(content.firstElementChild?.hasAttribute('data-rm-html'), true, 'fixture: the renderer flags the block');
      mouse(content.querySelector('span')!, 'dblclick');
      assert.deepEqual(vscode.posted, []);
    });

    it('ignores an element outside the preview content', () => {
      load();
      edit.setEditable(true, true);
      const outside = document.createElement('div');
      outside.dataset.line = '0';
      outside.dataset.lineEnd = '1';
      document.body.append(outside);
      mouse(outside, 'dblclick'); // the listener is on the content root, so it is never reached
      assert.deepEqual(vscode.posted, []);
    });

    it('with an editor already open it posts nothing new', () => {
      load();
      const area = openAt(PARA);
      edit.setEditable(true, true);
      vscode.clear();
      mouse(area, 'dblclick');
      mouse(block(HEADING), 'dblclick');
      assert.deepEqual(vscode.posted, []);
      assert.equal(document.activeElement, area);
    });
  });
});
