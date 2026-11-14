// Resizable table columns: drag a column's right border (in any row) to set its width, double-click
// a border to give the table back its automatic layout. The first drag freezes every column at its
// current width in an injected `<colgroup class="rm-colgroup">` (`width` + `min-width`: `width` alone
// lets the anonymous inner table squeeze columns instead of scrolling) and tags the table
// `.rm-table-sized`, whose cells may then wrap anywhere so a column can be narrower than its text.
// No wrapper element: the table itself stays the `[data-line-end]` block.
//
// Widths live in this preview's WebviewState, so they survive re-renders and reloads. A table is
// keyed by its header text (+ occurrence); when no saved key matches, e.g. while a header cell is
// being edited, an unclaimed entry at the same table position with the same column count is
// adopted and re-keyed.
import type { TableWidths } from '../src/protocol';
import { getState, patchState } from './api';
import { REMOVED_SELECTOR } from './changes';
import { invalidate } from './scroll';

/** Distance from a border (each side) that grabs it, in px. */
const EDGE = 5;
const MIN_WIDTH = 40;
/** Saved entries kept for tables not in the document (any more, or for now). */
const MAX_STALE = 30;

interface Hit {
  table: HTMLTableElement;
  /** Column left of the border. */
  col: number;
  /** A cell whose right edge is the border (positions the guide). */
  edgeCell: HTMLTableCellElement;
}

interface Drag extends Hit {
  pointerId: number;
  startX: number;
  startWidth: number;
  moved: boolean;
}

let root: HTMLElement;
let guide: HTMLElement | undefined;
let hovered: HTMLTableElement | undefined;
let drag: Drag | undefined;

function columnCount(table: HTMLTableElement): number {
  const row = table.rows[0];
  return row ? [...row.cells].reduce((n, c) => n + c.colSpan, 0) : 0;
}

/** Author-supplied `<col>`s would shift ours; such tables keep their own layout. */
function isResizable(table: HTMLTableElement): boolean {
  return (
    root.contains(table) &&
    !table.closest(REMOVED_SELECTOR) &&
    !table.querySelector(':scope > colgroup:not(.rm-colgroup), :scope > col') &&
    columnCount(table) > 0
  );
}

function resizableTables(): HTMLTableElement[] {
  return [...root.querySelectorAll('table')].filter(isResizable);
}

/** Header text without words shown as deleted, so inline and gutter change modes agree. */
function cellText(cell: Element): string {
  let text = '';
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('del.rm-del')) text += n.nodeValue;
  }
  return text.trim().replace(/\s+/g, ' ');
}

function tableKeys(tables: HTMLTableElement[]): string[] {
  const seen = new Map<string, number>();
  return tables.map((t) => {
    const header = t.rows[0] ? [...t.rows[0].cells].map(cellText).join('␟') : '';
    const n = seen.get(header) ?? 0;
    seen.set(header, n + 1);
    return `${header}#${n}`;
  });
}

function colgroup(table: HTMLTableElement): HTMLTableColElement[] {
  let group = table.querySelector<HTMLTableColElement>(':scope > colgroup.rm-colgroup');
  const count = columnCount(table);
  if (!group || group.children.length !== count) {
    group?.remove();
    group = document.createElement('colgroup');
    group.className = 'rm-colgroup';
    for (let i = 0; i < count; i++) group.append(document.createElement('col'));
    table.prepend(group);
  }
  table.classList.add('rm-table-sized');
  return [...group.children] as HTMLTableColElement[];
}

function setWidth(col: HTMLTableColElement, width: number): void {
  col.style.width = col.style.minWidth = `${width}px`;
}

function widthsOf(table: HTMLTableElement): number[] {
  return colgroup(table).map((c) => parseFloat(c.style.width) || 0);
}

/** Pins every column at its laid-out width; false if no row has one cell per column. */
function freeze(table: HTMLTableElement): boolean {
  if (table.classList.contains('rm-table-sized')) return true;
  const count = columnCount(table);
  const row = [...table.rows].find((r) => r.cells.length === count);
  if (!row) return false;
  const widths = [...row.cells].map((c) => Math.round(c.getBoundingClientRect().width));
  colgroup(table).forEach((col, i) => setWidth(col, widths[i]));
  return true;
}

function unfreeze(table: HTMLTableElement): void {
  table.querySelector(':scope > colgroup.rm-colgroup')?.remove();
  table.classList.remove('rm-table-sized');
}

// ---- persistence ---------------------------------------------------------------------------

function save(): void {
  const tables = resizableTables();
  const keys = tableKeys(tables);
  const current: TableWidths[] = [];
  tables.forEach((t, index) => {
    if (t.classList.contains('rm-table-sized')) current.push({ key: keys[index], index, widths: widthsOf(t) });
  });
  const live = new Set(keys);
  const stale = (getState().tableWidths ?? []).filter((e) => !live.has(e.key)).slice(-MAX_STALE);
  patchState({ tableWidths: [...stale, ...current] });
}

/** Re-applies saved column widths after a render. */
export function applyTableWidths(): void {
  const saved = getState().tableWidths;
  if (!saved?.length) return;
  const tables = resizableTables();
  const keys = tableKeys(tables);
  const unclaimed = new Set(saved);
  const assign = new Map<number, TableWidths>();
  const fits = (e: TableWidths, i: number) => e.widths.length === columnCount(tables[i]);
  keys.forEach((key, i) => {
    const entry = saved.find((e) => e.key === key && unclaimed.has(e) && fits(e, i));
    if (!entry) return;
    assign.set(i, entry);
    unclaimed.delete(entry);
  });
  const adopted = new Set<TableWidths>();
  tables.forEach((_, i) => {
    if (assign.has(i)) return;
    const entry = [...unclaimed].find((e) => e.index === i && fits(e, i) && !keys.includes(e.key));
    if (!entry) return;
    assign.set(i, entry);
    unclaimed.delete(entry);
    adopted.add(entry);
  });
  for (const [i, entry] of assign) colgroup(tables[i]).forEach((col, c) => setWidth(col, entry.widths[c]));
  if (adopted.size) {
    // Saved again under the table's new key.
    patchState({ tableWidths: saved.filter((e) => !adopted.has(e)) });
    save();
  }
}

// ---- pointer -------------------------------------------------------------------------------

/** Column index of a cell's first column (colspans counted). */
function cellStart(cell: HTMLTableCellElement): number {
  let n = 0;
  for (let c = cell.previousElementSibling; c; c = c.previousElementSibling) n += (c as HTMLTableCellElement).colSpan || 1;
  return n;
}

function hitTest(e: MouseEvent): Hit | undefined {
  // From the point, not `e.target`: after a drag the pointer capture retargets clicks to the table.
  const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLTableCellElement>('th, td');
  const table = cell?.closest('table');
  if (!cell || !table || !isResizable(table)) return undefined;
  const r = cell.getBoundingClientRect();
  if (e.clientX >= r.right - EDGE) return { table, col: cellStart(cell) + cell.colSpan - 1, edgeCell: cell };
  const prev = cell.previousElementSibling as HTMLTableCellElement | null;
  if (e.clientX <= r.left + EDGE && prev) return { table, col: cellStart(cell) - 1, edgeCell: prev };
  return undefined;
}

function setHovered(table: HTMLTableElement | undefined): void {
  if (hovered === table) return;
  hovered?.classList.remove('rm-col-resize-hover');
  table?.classList.add('rm-col-resize-hover');
  hovered = table;
}

function showGuide(hit: Hit | undefined): void {
  if (!hit) {
    if (guide) guide.hidden = true;
    return;
  }
  if (!guide) {
    guide = document.createElement('div');
    guide.id = 'rm-col-guide';
    guide.setAttribute('aria-hidden', 'true');
    document.body.append(guide);
  }
  const t = hit.table.getBoundingClientRect();
  const x = Math.min(t.right, Math.max(t.left, hit.edgeCell.getBoundingClientRect().right));
  Object.assign(guide.style, { left: `${x - 1}px`, top: `${t.top}px`, height: `${t.height}px` });
  guide.hidden = false;
}

function onPointerMove(e: PointerEvent): void {
  if (drag) {
    if (e.pointerId !== drag.pointerId) return;
    const width = Math.max(MIN_WIDTH, Math.round(drag.startWidth + e.clientX - drag.startX));
    setWidth(colgroup(drag.table)[drag.col], width);
    drag.moved = true;
    showGuide(drag);
    return;
  }
  if (e.buttons) return;
  const hit = hitTest(e);
  setHovered(hit?.table);
  showGuide(hit);
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || drag) return;
  const hit = hitTest(e);
  if (!hit || !freeze(hit.table)) return;
  // Before block editing, selection and the other content handlers see it.
  e.preventDefault();
  e.stopPropagation();
  hit.table.setPointerCapture(e.pointerId);
  const startWidth = parseFloat(colgroup(hit.table)[hit.col].style.width);
  drag = { ...hit, pointerId: e.pointerId, startX: e.clientX, startWidth, moved: false };
  document.body.classList.add('rm-col-resizing');
}

function endDrag(): void {
  if (!drag) return;
  const { table, moved } = drag;
  drag = undefined;
  document.body.classList.remove('rm-col-resizing');
  showGuide(undefined);
  if (moved) {
    // The click that ends the drag must not follow a link or toggle a checkbox in the cell.
    window.addEventListener('click', swallowClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 0);
    save();
  } else if (!savedFor(table)) {
    // A plain click on a border (or the first click of a double-click) does not pin the table.
    unfreeze(table);
  }
  invalidate();
}

function swallowClick(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

function savedFor(table: HTMLTableElement): boolean {
  const tables = resizableTables();
  const i = tables.indexOf(table);
  if (i < 0) return false;
  const key = tableKeys(tables)[i];
  return !!getState().tableWidths?.some((e) => e.key === key);
}

function onDoubleClick(e: MouseEvent): void {
  const hit = hitTest(e);
  if (!hit) return;
  // Not a block edit (`edit.doubleClick`) or a word selection.
  e.preventDefault();
  e.stopPropagation();
  window.getSelection()?.removeAllRanges();
  unfreeze(hit.table);
  save();
  invalidate();
  showGuide(undefined);
}

export function initTableResize(content: HTMLElement): void {
  root = content;
  content.addEventListener('pointermove', onPointerMove);
  content.addEventListener('pointerdown', onPointerDown, { capture: true });
  content.addEventListener('pointerup', endDrag);
  content.addEventListener('lostpointercapture', endDrag);
  content.addEventListener('dblclick', onDoubleClick, { capture: true });
  content.addEventListener('pointerleave', () => {
    if (drag) return;
    setHovered(undefined);
    showGuide(undefined);
  });
  window.addEventListener('scroll', () => !drag && showGuide(undefined), { passive: true });
}

/** Before a render replaces the tables: keeps the width reached so far. */
export function cancelTableResize(): void {
  if (drag) endDrag();
  setHovered(undefined);
  showGuide(undefined);
}
