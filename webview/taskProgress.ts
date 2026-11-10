// Task-list progress, for plans an AI agent works through step by step. The renderer flags
// in-progress items (`- [/] step`, also `[~]` / `[-]`) with `data-task="active"`; CSS draws the
// "working" label. This module adds what needs the previous render: a "just done" flash when an
// in-progress step is checked, following newly started steps, plus the progress bar and the
// per-heading counts shown in the outline.
import { getState, patchState } from './api';
import { REMOVED_SELECTOR } from './changes';
import { expandTo } from './sections';
import { invalidate, msSinceUserInput, scrollProgrammatically } from './scroll';

type TaskState = 'todo' | 'active' | 'done';

export interface TaskCounts {
  total: number;
  done: number;
  active: number;
}

export interface TaskUpdateOptions {
  /** The whole feature (`readMarkdown.tasks.agentProgress`); off = no flash, follow, bar or counts. */
  enabled: boolean;
  /** Show the progress bar and outline counts (`readMarkdown.tasks.progress`). */
  progress: boolean;
  /** True while a block is open for editing: never scroll then. */
  busy: boolean;
}

const ITEM = 'li.task-list-item';
const CHECKBOX = ':scope > label > input.task-list-item-checkbox, :scope > p:first-child > label > input.task-list-item-checkbox';
const HEADING = /^H([1-6])$/;
/** Leave the reader alone for this long after they scrolled or clicked. */
const FOLLOW_IDLE_MS = 2000;
const JUST_DONE_CLASS = 'rm-task-just-done';

let content: HTMLElement;
let bar: HTMLElement;
let followButton: HTMLButtonElement;
/** Task states by item key from the previous render; undefined until the first render. */
let previous: Map<string, TaskState> | undefined;

export function initTaskProgress(opts: { content: HTMLElement; bar: HTMLElement; followButton: HTMLButtonElement }): void {
  content = opts.content;
  bar = opts.bar;
  followButton = opts.followButton;
  followButton.addEventListener('click', () => {
    patchState({ followTasks: !following() });
    syncFollowButton(true);
    if (following()) revealFirst(content.querySelectorAll<HTMLElement>(`${ITEM}[data-task="active"]`), true);
  });
  content.addEventListener('animationend', (e) => {
    if (e.animationName === 'rm-task-just-done') (e.target as Element).closest(`.${JUST_DONE_CLASS}`)?.classList.remove(JUST_DONE_CLASS);
  });
}

function following(): boolean {
  return getState().followTasks !== false;
}

function syncFollowButton(visible: boolean): void {
  followButton.hidden = !visible;
  const on = following();
  const label = on ? 'Stop following steps in progress' : 'Follow steps in progress';
  followButton.title = label;
  followButton.setAttribute('aria-pressed', String(on));
}

function stateOf(li: HTMLElement): TaskState {
  if (li.dataset.task === 'active') return 'active';
  return li.querySelector<HTMLInputElement>(CHECKBOX)?.checked ? 'done' : 'todo';
}

/**
 * The item's own text (not its nested lists), ignoring words struck out by inline track changes.
 * Identifies an item across renders: an agent's edits shift line numbers, not the step's wording.
 */
function itemText(li: HTMLElement): string {
  const own = li.querySelector(':scope > label, :scope > p:first-child') ?? li;
  let text = '';
  const walker = document.createTreeWalker(own, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('del.rm-del, ul, ol')) text += n.textContent;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function taskItems(): HTMLElement[] {
  return [...content.querySelectorAll<HTMLElement>(ITEM)].filter((li) => !li.closest(REMOVED_SELECTOR));
}

/**
 * Call after each render, once sections are built and the scroll position restored. Returns the
 * per-heading counts for the outline (undefined when progress display is off).
 */
export function updateTaskProgress(opts: TaskUpdateOptions): Map<string, TaskCounts> | undefined {
  if (!opts.enabled) {
    // Forget the states, so turning the feature back on does not flash or follow anything.
    previous = undefined;
    syncFollowButton(false);
    updateBar(undefined);
    return undefined;
  }
  const items = taskItems();
  const states = new Map<string, TaskState>();
  const seen = new Map<string, number>();
  const started: HTMLElement[] = [];
  const total: TaskCounts = { total: 0, done: 0, active: 0 };

  for (const li of items) {
    const state = stateOf(li);
    const text = itemText(li);
    // Same wording twice: tell them apart by occurrence.
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    const key = `${text}\u0000${n}`;
    states.set(key, state);
    count(total, state);

    const before = previous?.get(key);
    if (before === undefined && previous) {
      // New or reworded item: nothing to compare against.
    } else if (state === 'done' && before === 'active') {
      li.classList.add(JUST_DONE_CLASS);
    } else if (state === 'active' && before !== 'active' && previous) {
      started.push(li);
    }
  }
  const firstRender = !previous;
  previous = states;

  syncFollowButton(total.active > 0);
  if (!firstRender && started.length && following() && !opts.busy && msSinceUserInput() > FOLLOW_IDLE_MS) revealFirst(started, false);
  updateBar(opts.progress ? total : undefined);
  return opts.progress ? headingCounts() : undefined;
}

function count(c: TaskCounts, state: TaskState): void {
  c.total++;
  if (state === 'done') c.done++;
  else if (state === 'active') c.active++;
}

/** Brings the first of `items` into view (expanding its section), unless it already is. */
function revealFirst(items: ArrayLike<HTMLElement>, force: boolean): void {
  const li = items[0];
  if (!li) return;
  if (expandTo(li)) invalidate();
  const rect = li.getBoundingClientRect();
  const margin = 40;
  const visible = rect.top >= margin && rect.top <= window.innerHeight - margin;
  if (visible && !force) return;
  // Not echoed to the source editor: the agent moved on, not the reader.
  scrollProgrammatically(window.scrollY + rect.top - window.innerHeight / 3);
}

function updateBar(c: TaskCounts | undefined): void {
  if (!c || c.total === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.style.setProperty('--rm-task-done', `${(c.done / c.total) * 100}%`);
  bar.style.setProperty('--rm-task-active', `${(c.active / c.total) * 100}%`);
  bar.setAttribute('aria-valuemax', String(c.total));
  bar.setAttribute('aria-valuenow', String(c.done));
  const text = `${c.done} of ${c.total} done` + (c.active ? ` · ${c.active} in progress` : '');
  bar.setAttribute('aria-valuetext', text);
  bar.title = text;
}

/**
 * Task counts under each outline heading (slug → counts), nested headings included in their
 * parents. Works with or without collapsible sections: walks headings and items in document order.
 */
function headingCounts(): Map<string, TaskCounts> {
  const result = new Map<string, TaskCounts>();
  const stack: { level: number; counts: TaskCounts }[] = [];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode() as HTMLElement | null; n; n = walker.nextNode() as HTMLElement | null) {
    const m = HEADING.exec(n.tagName);
    if (m) {
      // Outline headings only: top level, or the heading of a section (see sections.ts).
      const parent = n.parentElement;
      if (!n.id || n.matches(REMOVED_SELECTOR) || !(parent === content || parent?.matches('section.rm-section'))) continue;
      const level = Number(m[1]);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const counts: TaskCounts = { total: 0, done: 0, active: 0 };
      result.set(n.id, counts);
      stack.push({ level, counts });
    } else if (n.matches(ITEM) && !n.closest(REMOVED_SELECTOR)) {
      const state = stateOf(n);
      for (const s of stack) count(s.counts, state);
    }
  }
  for (const [slug, c] of result) if (c.total === 0) result.delete(slug);
  return result;
}
