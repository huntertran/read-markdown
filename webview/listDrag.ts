// Drag-to-reorder for list items (edit mode). Hovering an item shows a grip left of its bullet or
// checkbox; dragging it lifts the item and slides its siblings apart to open the gap where it will
// land (FLIP-style transforms, nothing re-laid out while dragging). With reduced motion the list
// does not animate: a line marks the drop point and the list snaps to the new order on release.
// Alt+Up/Down on the focused grip moves an item by one.
//
// The preview reorders its own DOM first and then asks the extension to move the source lines.
// The extension renders right after a successful edit, so the new content matches what is already
// shown; on failure the items are put back.
import type { EditError, ToWebview } from '../src/protocol';
import { post } from './api';
import { REMOVED_SELECTOR } from './changes';
import { invalidate } from './scroll';

interface Options {
  content: HTMLElement;
  /** `docVersion` of the render currently shown (the one item line numbers refer to). */
  docVersion: () => number | undefined;
  /** True while something else (the block editor) owns the content. */
  isBusy: () => boolean;
}

interface Drag {
  li: HTMLLIElement;
  list: HTMLElement;
  items: HTMLLIElement[];
  /** Page-relative tops and heights at drag start. */
  tops: number[];
  heights: number[];
  idx: number;
  target: number;
  startY: number;
  lastClientY: number;
  pointerId: number;
  reduced: boolean;
  line?: HTMLElement;
}

interface Pending {
  list: HTMLElement;
  /** The list's children before the optimistic reorder, to put back if the move fails. */
  children: Element[];
  /** Re-show and focus the grip on the moved item once the new render is in (keyboard moves). */
  refocus: boolean;
}

/** Grip size and its right edge relative to the list's left edge (inside the list's padding). */
const GRIP_W = 12;
const GRIP_H = 20;
const GRIP_RIGHT = 6;
const SETTLE_MS = 200;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

const MESSAGES: Record<EditError, string> = {
  stale: 'The file changed before the move was saved, so the list was put back.',
  readonly: 'This document is read-only.',
  invalid: 'This list could not be reordered in the source.',
  failed: 'VS Code could not apply the move.',
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let opts: Options;
let enabled = false;
let grip: HTMLButtonElement;
let gripItem: HTMLLIElement | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let drag: Drag | undefined;
let pending: Pending | undefined;
/** True while a dropped item glides into place, before the move is sent. */
let settling = false;

export function initListDrag(options: Options): void {
  opts = options;
  grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'rm-item-grip';
  grip.title = 'Drag to reorder (Alt+↑/↓)';
  grip.setAttribute('aria-label', 'Move list item. Alt+Up or Alt+Down moves it by one.');
  grip.hidden = true;
  grip.append(gripIcon());
  document.body.append(grip);

  grip.addEventListener('pointerdown', onPointerDown);
  grip.addEventListener('keydown', onGripKey);

  // mousemove, not mouseover: inside a list's padding or the gaps between items the pointer stays
  // on the same <ul>, yet the item it points at changes with its height.
  let frame = 0;
  let last: MouseEvent | undefined;
  document.addEventListener('mousemove', (e) => {
    last = e;
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      if (last) onHover(last);
    });
  });
  window.addEventListener('resize', hideGrip);
}

function onHover(e: MouseEvent): void {
  if (!enabled || drag) return;
  const target = e.target as Element;
  if (!target.isConnected) return;
  if (grip.contains(target)) {
    clearTimeout(hideTimer);
    return;
  }
  const li = movableItem(target) ?? itemAtY(target, e.clientY);
  if (li && !pending && !settling && !opts.isBusy()) {
    if (li !== gripItem || grip.hidden) showGrip(li);
    else clearTimeout(hideTimer);
  } else {
    // Delay hiding so the pointer can reach the grip from the item text.
    scheduleHide();
  }
}

/**
 * For a pointer over a list's own box (its left padding, where the grip and bullets sit, or a gap
 * between items): the item on that row, or the nearest one.
 */
function itemAtY(target: Element, y: number): HTMLLIElement | undefined {
  if (target.tagName !== 'UL' && target.tagName !== 'OL') return undefined;
  let best: HTMLLIElement | undefined;
  let bestDistance = Infinity;
  for (const li of siblings(target)) {
    const r = li.getBoundingClientRect();
    const distance = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (distance < bestDistance) {
      best = li;
      bestDistance = distance;
    }
  }
  return best && movableItem(best) === best ? best : undefined;
}

export function setListDragEnabled(value: boolean): void {
  enabled = value;
  if (!value) {
    cancelListDrag();
    hideGrip();
  }
}

/** Call before the content is replaced: drops any drag in progress and the grip. */
export function cancelListDrag(): void {
  if (drag) finish(true, true);
  settling = false;
  if (!grip.contains(document.activeElement)) hideGrip();
  else gripItem = undefined;
}

/** Viewport x of the item grip's left edge for `list`, so other gutter controls keep clear of it. */
export function itemGripLeft(list: Element): number {
  return list.getBoundingClientRect().left + GRIP_RIGHT - GRIP_W;
}

export function onMoveResult(msg: Extract<ToWebview, { type: 'moveResult' }>): void {
  const p = pending;
  pending = undefined;
  if (!p) return;
  if (!msg.ok) {
    // Put the items back in their original order (the content was not re-rendered), with any
    // track-changes copies between them where they were.
    if (p.children.every((c) => c.parentElement === p.list)) {
      for (const c of p.children) p.list.append(c);
      invalidate();
    }
    flash(p.list, MESSAGES[msg.error ?? 'failed']);
    if (grip.contains(document.activeElement)) grip.blur();
    hideGrip();
    return;
  }
  // The new render has already arrived (it is posted before the result).
  if (p.refocus && msg.line !== undefined) {
    const li = opts.content.querySelector<HTMLLIElement>(`li[data-item-end][data-line="${msg.line}"]`);
    if (li && movableItem(li) === li) {
      showGrip(li);
      grip.focus({ preventScroll: true });
      return;
    }
  }
  if (!grip.contains(document.activeElement)) hideGrip();
}

// ---- grip ------------------------------------------------------------------------------------

/** The innermost list item under `el` that can be reordered, if any. */
function movableItem(el: Element): HTMLLIElement | undefined {
  const li = el.closest('li');
  if (!li || !opts.content.contains(li) || li.closest('blockquote, .rm-edit')) return undefined;
  const list = li.parentElement;
  if (!list || (list.tagName !== 'UL' && list.tagName !== 'OL')) return undefined;
  const items = siblings(list);
  if (items.length < 2 || items.some((i) => i.dataset.line === undefined || i.dataset.itemEnd === undefined)) return undefined;
  return li;
}

/** The list's real items: removed / moved-from copies shown by track changes are not in the source. */
function siblings(list: Element): HTMLLIElement[] {
  return [...list.children].filter((c): c is HTMLLIElement => c.tagName === 'LI' && !c.matches(REMOVED_SELECTOR));
}

function showGrip(li: HTMLLIElement): void {
  clearTimeout(hideTimer);
  gripItem = li;
  grip.hidden = false;
  const rect = li.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(li).lineHeight) || rect.height;
  const top = rect.top + (Math.min(lineHeight, rect.height) - GRIP_H) / 2;
  grip.style.left = `${Math.max(2, itemGripLeft(li.parentElement!)) + window.scrollX}px`;
  grip.style.top = `${top + window.scrollY}px`;
}

function scheduleHide(): void {
  if (grip.hidden || grip.contains(document.activeElement)) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideGrip, 400);
}

function hideGrip(): void {
  clearTimeout(hideTimer);
  grip.hidden = true;
  gripItem = undefined;
}

// ---- keyboard --------------------------------------------------------------------------------

function onGripKey(e: KeyboardEvent): void {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const li = gripItem;
  if (!li || !li.isConnected || pending || drag || settling || opts.isBusy()) return;
  const list = li.parentElement!;
  const items = siblings(list);
  const from = items.indexOf(li);
  const to = from + (e.key === 'ArrowUp' ? -1 : 1);
  if (to < 0 || to >= items.length) return;

  const animate = !reducedMotion.matches;
  const before = new Map(items.map((el) => [el, el.getBoundingClientRect().top]));
  const previous = reorder(list, items, from, to);
  // Measure the grip's new spot before the animation offsets the item.
  showGrip(li);
  if (animate) {
    for (const el of items) {
      const dy = before.get(el)! - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 0.5) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: SETTLE_MS, easing: EASE });
    }
  }
  send(list, items, previous, from, to, true);
}

// ---- pointer drag ------------------------------------------------------------------------------

function onPointerDown(e: PointerEvent): void {
  const li = gripItem;
  if (e.button !== 0 || !li || !li.isConnected || drag || pending || settling || opts.isBusy()) return;
  e.preventDefault();
  const list = li.parentElement!;
  // Before measuring: this also hides track-changes copies, which would skew the item slots.
  list.classList.add('rm-list-reordering');
  const items = siblings(list);
  const rects = items.map((el) => el.getBoundingClientRect());
  drag = {
    li,
    list,
    items,
    tops: rects.map((r) => r.top + window.scrollY),
    heights: rects.map((r) => r.height),
    idx: items.indexOf(li),
    target: items.indexOf(li),
    startY: e.clientY + window.scrollY,
    lastClientY: e.clientY,
    pointerId: e.pointerId,
    reduced: reducedMotion.matches,
  };
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {
    /* pointer already gone; the drag still ends on pointerup/cancel */
  }
  // Keep the grip rendered (it holds the pointer capture), just invisible.
  grip.classList.add('rm-item-grip-dragging');
  document.body.classList.add('rm-list-dragging');
  if (drag.reduced) {
    li.classList.add('rm-li-drag-source');
    const line = document.createElement('div');
    line.className = 'rm-drop-line';
    line.hidden = true;
    document.body.append(line);
    drag.line = line;
  } else {
    li.classList.add('rm-li-lifted');
  }
  grip.addEventListener('pointermove', onPointerMove);
  grip.addEventListener('pointerup', onPointerUp);
  grip.addEventListener('pointercancel', onPointerCancel);
  grip.addEventListener('lostpointercapture', onPointerCancel);
  window.addEventListener('keydown', onDragKey, true);
  window.addEventListener('scroll', onScroll, { passive: true });
}

function onPointerMove(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.lastClientY = e.clientY;
  update(e.clientY + window.scrollY);
}

function onScroll(): void {
  if (drag) update(drag.lastClientY + window.scrollY);
}

/** Distance from item `i`'s top to the next item's top (the last uses the gap above it). */
function slot(d: Drag, i: number): number {
  const n = d.tops.length;
  if (i + 1 < n) return d.tops[i + 1] - d.tops[i];
  const gap = n > 1 ? d.tops[i] - (d.tops[i - 1] + d.heights[i - 1]) : 0;
  return d.heights[i] + gap;
}

function update(pageY: number): void {
  const d = drag!;
  const { tops, heights, idx } = d;
  const n = tops.length;
  const mid = (i: number) => tops[i] + heights[i] / 2;
  const minDy = tops[0] - tops[idx];
  const maxDy = tops[n - 1] + heights[n - 1] - (tops[idx] + heights[idx]);
  const dy = Math.max(minDy, Math.min(maxDy, pageY - d.startY));

  if (d.reduced) {
    // Drop line: insert before the first item whose middle is below the pointer.
    let k = 0;
    while (k < n && pageY > mid(k)) k++;
    d.target = k > idx ? k - 1 : k;
    const line = d.line!;
    line.hidden = d.target === idx;
    const y = k < n ? tops[k] - 2 : tops[n - 1] + heights[n - 1] + 1;
    const listRect = d.list.getBoundingClientRect();
    line.style.top = `${y}px`;
    line.style.left = `${listRect.left + window.scrollX + GRIP_RIGHT}px`;
    line.style.width = `${Math.max(0, listRect.width - GRIP_RIGHT)}px`;
    return;
  }

  // Live reorder: the dragged item's middle passing a sibling's middle moves the target.
  const center = mid(idx) + dy;
  let t = idx;
  for (let i = idx + 1; i < n; i++) if (center > mid(i)) t = i;
  if (t === idx) for (let i = idx - 1; i >= 0; i--) if (center < mid(i)) t = i;
  d.target = t;
  d.li.style.transform = `translateY(${dy}px)`;
  const shift = slot(d, idx);
  d.items.forEach((el, i) => {
    if (el === d.li) return;
    let s = 0;
    if (t > idx && i > idx && i <= t) s = -shift;
    else if (t < idx && i >= t && i < idx) s = shift;
    el.style.transform = s ? `translateY(${s}px)` : '';
  });
}

function onPointerUp(e: PointerEvent): void {
  if (drag && e.pointerId === drag.pointerId) finish(false);
}

function onPointerCancel(): void {
  if (drag) finish(true);
}

function onDragKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !drag) return;
  e.preventDefault();
  e.stopPropagation();
  finish(true);
}

/** Ends the drag: settles the item into its slot, then reorders the DOM and sends the move. */
function finish(cancel: boolean, immediate = false): void {
  const d = drag!;
  drag = undefined;
  grip.removeEventListener('pointermove', onPointerMove);
  grip.removeEventListener('pointerup', onPointerUp);
  grip.removeEventListener('pointercancel', onPointerCancel);
  grip.removeEventListener('lostpointercapture', onPointerCancel);
  window.removeEventListener('keydown', onDragKey, true);
  window.removeEventListener('scroll', onScroll);
  if (grip.hasPointerCapture(d.pointerId)) grip.releasePointerCapture(d.pointerId);
  const to = cancel ? d.idx : d.target;

  const done = () => {
    settling = false;
    grip.classList.remove('rm-item-grip-dragging');
    hideGrip();
    document.body.classList.remove('rm-list-dragging');
    d.list.classList.remove('rm-list-reordering');
    d.li.classList.remove('rm-li-lifted', 'rm-li-drag-source');
    d.line?.remove();
    for (const el of d.items) {
      el.style.transition = 'none';
      el.style.transform = '';
    }
    const previous = to !== d.idx ? reorder(d.list, d.items, d.idx, to) : [];
    void d.list.offsetHeight;
    for (const el of d.items) el.style.transition = '';
    if (to !== d.idx && !immediate) send(d.list, d.items, previous, d.idx, to, false);
  };

  if (d.reduced || immediate) return done();

  // Glide the lifted item into its slot (or back to where it started), then commit.
  let offset = 0;
  if (to > d.idx) for (let i = d.idx + 1; i <= to; i++) offset += slot(d, i);
  else if (to < d.idx) for (let i = to; i < d.idx; i++) offset -= slot(d, i);
  if (cancel) for (const el of d.items) if (el !== d.li) el.style.transform = '';
  d.li.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
  d.li.style.transform = offset ? `translateY(${offset}px)` : '';
  d.li.classList.add('rm-li-settling');
  settling = true;
  setTimeout(() => {
    d.li.classList.remove('rm-li-settling');
    // A render replaced the list meanwhile: its line numbers are gone, so drop the move.
    if (!d.list.isConnected) {
      settling = false;
      document.body.classList.remove('rm-list-dragging');
      grip.classList.remove('rm-item-grip-dragging');
      return;
    }
    done();
  }, SETTLE_MS);
}

// ---- commit ----------------------------------------------------------------------------------

/** Moves `items[from]` to position `to` in the DOM. Returns the list's children as they were. */
function reorder(list: HTMLElement, items: HTMLLIElement[], from: number, to: number): Element[] {
  const previous = [...list.children];
  const rest = items.filter((_, i) => i !== from);
  list.insertBefore(items[from], rest[to] ?? null);
  invalidate();
  return previous;
}

function send(list: HTMLElement, items: HTMLLIElement[], previous: Element[], from: number, to: number, refocus: boolean): void {
  const docVersion = opts.docVersion();
  const starts = items.map((li) => Number(li.dataset.line));
  const end = Number(items[items.length - 1].dataset.itemEnd);
  pending = { list, children: previous, refocus };
  if (docVersion === undefined) {
    onMoveResult({ type: 'moveResult', ok: false, error: 'failed' });
    return;
  }
  post({ type: 'moveListItem', starts, end, from, to, docVersion });
}

/** Short-lived message under the list. */
function flash(list: HTMLElement, text: string): void {
  const note = document.createElement('div');
  note.className = 'rm-edit-flash';
  note.setAttribute('role', 'status');
  note.textContent = text;
  list.after(note);
  setTimeout(() => note.remove(), 4000);
}

function gripIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 6 10');
  svg.setAttribute('width', '6');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cx, cy] of [[1, 1], [5, 1], [1, 5], [5, 5], [1, 9], [5, 9]]) {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', '1');
    dot.setAttribute('fill', 'currentColor');
    svg.append(dot);
  }
  return svg;
}
