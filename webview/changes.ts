// Shows how the document differs from its git index version, Word "track changes" style.
//
// The extension aligns top-level blocks (`DocChanges.ops`, by source line) and sends the original
// rendered the same way. Here, before sections are built:
// - added blocks get `.rm-chg-ins`;
// - removed blocks are cloned in from the original as `.rm-chg-del` (inline mode);
// - modified lists / quotes / tables are aligned again child by child, other modified blocks get
//   a word diff: `<ins class="rm-ins">` / `<del class="rm-del">` over their text nodes;
// - moved blocks: `.rm-chg-move-from` (clone at the old place) / `.rm-chg-move-to`, paired by `data-move-id`.
// In gutter mode nothing is inserted or wrapped: elements are only tagged for the change bars
// (`changeGutter.ts`), and removals are marked on the following element (`data-rm-del-before`).
// Clones lose `data-line*` / `id`, so scroll sync, editing, search and the outline ignore them.
import { type AlignItem, alignBlocks } from '../src/diff/blockDiff';
import { diffTokens, similarity, tokenize, tokenizeLines } from '../src/diff/textDiff';
import type { DocChanges } from '../src/protocol';
import { sanitize } from './sanitize';

/** Removed content shown for reference only (not part of the current document). */
export const REMOVED_SELECTOR = '.rm-chg-del, .rm-chg-move-from';
/** Every element that gets a change bar. */
export const CHANGED_SELECTOR = '.rm-chg-ins, .rm-chg-mod, .rm-chg-del, .rm-chg-move-to, .rm-chg-move-from';

const STRIP_ATTRS = ['data-line', 'data-line-end', 'data-item-end', 'id', 'data-vscode-context'];
/** Blocks whose text can't be word-diffed meaningfully: shown as removed + added instead. */
const OPAQUE = '.rm-mermaid, hr, img, video, iframe, svg';
/** Below this word similarity a modified block reads better as removed + added. */
const MIN_WORD_SIMILARITY = 0.5;

interface Context {
  inline: boolean;
  /** Next id for moves found inside blocks (top-level ids come from the extension). */
  nextMoveId: number;
  /** Count of elements tagged so far (detects modified blocks whose text did not change). */
  marks: number;
}

export function applyChanges(root: HTMLElement, changes: DocChanges, mode: 'inline' | 'gutter'): void {
  const ctx: Context = { inline: mode === 'inline', nextMoveId: 0, marks: 0 };
  const original = new Map<number, HTMLElement>();
  // (`:scope` matches nothing on a DocumentFragment, so walk its children.)
  for (const el of sanitize(changes.originalHtml).children) {
    if (el instanceof HTMLElement && el.dataset.lineEnd !== undefined) original.set(Number(el.dataset.line), el);
  }
  const current = (line: number | null) =>
    line === null ? null : root.querySelector<HTMLElement>(`:scope > [data-line-end][data-line="${line}"]`);

  for (const op of changes.ops) {
    switch (op.op) {
      case 'ins': {
        const el = current(op.line);
        if (el) mark(el, 'rm-chg-ins', ctx);
        break;
      }
      case 'modify': {
        const el = current(op.line);
        const old = original.get(op.oldLine);
        if (el && old) diffBlock(old, el, ctx);
        else if (el) mark(el, 'rm-chg-mod', ctx);
        break;
      }
      case 'del':
      case 'moveFrom': {
        const old = original.get(op.oldLine);
        if (!old) break;
        const before = current(op.before);
        if (ctx.inline) {
          const clone = cloneRemoved(old, op.op === 'del' ? 'rm-chg-del' : 'rm-chg-move-from');
          if (op.op === 'moveFrom') clone.dataset.moveId = `b${op.id}`;
          root.insertBefore(clone, before);
        } else if (op.op === 'del') {
          markRemovedAt(root, before);
        }
        break;
      }
      case 'moveTo': {
        const el = current(op.line);
        if (!el) break;
        mark(el, 'rm-chg-move-to', ctx);
        el.dataset.moveId = `b${op.id}`;
        const old = original.get(op.oldLine);
        if (op.edited && ctx.inline && old) diffBlock(old, el, ctx, false);
        break;
      }
    }
  }
}

// ---- blocks ---------------------------------------------------------------------------------

/** Shows the changes between two versions of one block inside `el` (the current version). */
function diffBlock(old: HTMLElement, el: HTMLElement, ctx: Context, markModified = true): void {
  const before = ctx.marks;
  if (old.matches(OPAQUE) || el.matches(OPAQUE)) {
    replaceBlock(old, el, ctx);
  } else if (children(el) && el.tagName === old.tagName) {
    diffChildren(old, el, ctx);
  } else if (el.tagName === 'LI' && old.tagName === 'LI') {
    diffListItem(old, el, ctx);
  } else if (el.tagName === 'TR' && old.tagName === 'TR') {
    diffRow(old, el, ctx);
  } else {
    diffText(old, el, ctx);
  }
  // Only markup changed (link target, image, checkbox state): still flag the block.
  if (markModified && ctx.marks === before) mark(el, 'rm-chg-mod', ctx);
}

/** Children aligned as separate items: list items, quoted blocks, table rows. */
function children(el: Element): HTMLElement[] | undefined {
  switch (el.tagName) {
    case 'UL':
    case 'OL':
      return [...el.querySelectorAll<HTMLElement>(':scope > li')];
    case 'BLOCKQUOTE':
      return [...el.querySelectorAll<HTMLElement>(':scope > *')];
    case 'TABLE':
      return [...el.querySelectorAll<HTMLElement>(':scope > thead > tr, :scope > tbody > tr')];
    default:
      return undefined;
  }
}

function alignItem(el: HTMLElement): AlignItem {
  const checkbox = el.querySelector<HTMLInputElement>(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
  return {
    kind: el.tagName,
    text: el.textContent ?? '',
    key: markup(el) + (checkbox?.checked ? '☑' : ''),
  };
}

/** Markup without source positions, to compare versions rendered from different line numbers. */
function markup(el: Element): string {
  return el.outerHTML.replace(/\s(?:data-line|data-line-end|data-item-end|id)="[^"]*"/g, '');
}

function diffChildren(old: HTMLElement, el: HTMLElement, ctx: Context): void {
  const oldKids = children(old) ?? [];
  const newKids = children(el) ?? [];
  const ops = alignBlocks(oldKids.map(alignItem), newKids.map(alignItem), { firstMoveId: ctx.nextMoveId });
  if (!ops) {
    replaceBlock(old, el, ctx);
    return;
  }
  // Where a removed child goes: before the current child at `before`, else after the last one.
  const place = (node: HTMLElement, before: number) => {
    const ref = newKids[before];
    if (ref) ref.before(node);
    else if (newKids.length) newKids[newKids.length - 1].after(node);
    else (el.querySelector('tbody') ?? el).append(node);
  };
  for (const op of ops) {
    switch (op.op) {
      case 'ins':
        mark(newKids[op.b], 'rm-chg-ins', ctx);
        break;
      case 'modify':
        diffBlock(oldKids[op.a], newKids[op.b], ctx);
        break;
      case 'del':
        if (ctx.inline) place(cloneRemoved(oldKids[op.a], 'rm-chg-del'), op.before);
        else markRemovedAt(el, newKids[op.before] ?? null, newKids.at(-1));
        ctx.marks++;
        break;
      case 'moveFrom':
        if (ctx.inline) {
          const clone = cloneRemoved(oldKids[op.a], 'rm-chg-move-from');
          clone.dataset.moveId = `n${op.id}`;
          place(clone, op.before);
        }
        ctx.marks++;
        break;
      case 'moveTo':
        mark(newKids[op.b], 'rm-chg-move-to', ctx);
        newKids[op.b].dataset.moveId = `n${op.id}`;
        if (op.edited && ctx.inline) diffBlock(oldKids[op.a], newKids[op.b], ctx, false);
        ctx.nextMoveId = Math.max(ctx.nextMoveId, op.id + 1);
        break;
    }
  }
}

/** A list item: its own text word by word, nested lists item by item. */
function diffListItem(old: HTMLElement, el: HTMLElement, ctx: Context): void {
  diffText(old, el, ctx, { skip: 'ul, ol', inPlace: true });
  const oldLists = [...old.querySelectorAll<HTMLElement>(':scope > ul, :scope > ol')];
  const newLists = [...el.querySelectorAll<HTMLElement>(':scope > ul, :scope > ol')];
  newLists.forEach((list, i) => {
    const prev = oldLists[i];
    if (!prev) mark(list, 'rm-chg-ins', ctx);
    else if (markup(prev) !== markup(list)) diffBlock(prev, list, ctx);
  });
  for (const prev of oldLists.slice(newLists.length)) {
    if (ctx.inline) el.append(cloneRemoved(prev, 'rm-chg-del'));
    ctx.marks++;
  }
}

/** A table row: cell by cell when the column count is unchanged. */
function diffRow(old: HTMLElement, el: HTMLElement, ctx: Context): void {
  const oldCells = [...old.querySelectorAll<HTMLElement>(':scope > th, :scope > td')];
  const newCells = [...el.querySelectorAll<HTMLElement>(':scope > th, :scope > td')];
  if (oldCells.length !== newCells.length) {
    replaceBlock(old, el, ctx);
    return;
  }
  newCells.forEach((cell, i) => {
    if (markup(oldCells[i]) !== markup(cell)) diffText(oldCells[i], cell, ctx, { inPlace: true });
  });
}

/** Too different (or not text): the old version as removed, the new one as added. */
function replaceBlock(old: HTMLElement, el: HTMLElement, ctx: Context): void {
  if (!ctx.inline) {
    mark(el, 'rm-chg-mod', ctx);
    return;
  }
  el.before(cloneRemoved(old, 'rm-chg-del'));
  mark(el, 'rm-chg-ins', ctx);
}

// ---- words ----------------------------------------------------------------------------------

interface TextDiffOptions {
  /** Subtrees left out of the comparison (a list item's nested lists). */
  skip?: string;
  /**
   * Show a rewrite as removed + added text inside `el` instead of replacing the whole element
   * (table cells, list item text: a second element would break the structure).
   */
  inPlace?: boolean;
}

/** Word diff of the text in `old` → `el`, applied to `el`. */
function diffText(old: HTMLElement, el: HTMLElement, ctx: Context, { skip, inPlace }: TextDiffOptions = {}): void {
  const nodes = textNodes(el, skip);
  const oldText = textNodes(old, skip)
    .map((n) => n.data)
    .join('');
  const newText = nodes.map((n) => n.data).join('');
  if (oldText === newText) return;
  const code = el.tagName === 'PRE' || el.querySelector('pre') !== null;
  const runs = code ? diffTokens(tokenizeLines(oldText), tokenizeLines(newText)) : diffTokens(tokenize(oldText), tokenize(newText));
  if (!runs || (!code && oldText.trim() && newText.trim() && similarity(oldText, newText) < MIN_WORD_SIMILARITY)) {
    if (inPlace) {
      mark(el, 'rm-chg-mod', ctx);
      if (ctx.inline) wrapRuns(el, nodes, [{ op: 'del', text: oldText }, { op: 'ins', text: newText }]);
    } else {
      replaceBlock(old, el, ctx);
    }
    return;
  }
  mark(el, 'rm-chg-mod', ctx);
  if (ctx.inline) wrapRuns(el, nodes, runs);
}

function textNodes(el: HTMLElement, skip?: string): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const skipped = skip ? n.parentElement?.closest(skip) : null;
      return skipped && skipped !== el && el.contains(skipped) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  return nodes;
}

/**
 * Rewrites `nodes` (the text of `el`, in order) so inserted runs are wrapped in `<ins>` and deleted
 * runs appear as `<del>` where they were. Runs never cross elements: an insertion spanning a link
 * becomes one `<ins>` per text node, so inline formatting is kept.
 */
function wrapRuns(el: HTMLElement, nodes: Text[], runs: readonly { op: 'eq' | 'ins' | 'del'; text: string }[]): void {
  // Positions in the new text: inserted ranges and deletions (anchored where they happened).
  const inserted: [number, number][] = [];
  const deleted: { at: number; text: string }[] = [];
  let pos = 0;
  for (const r of runs) {
    if (r.op === 'del') deleted.push({ at: pos, text: r.text });
    else {
      if (r.op === 'ins') inserted.push([pos, pos + r.text.length]);
      pos += r.text.length;
    }
  }
  const total = pos;
  if (nodes.length === 0) {
    for (const d of deleted) el.append(tag('del', 'rm-del', d.text));
    return;
  }

  let di = 0;
  let ii = 0;
  let start = 0;
  nodes.forEach((node, index) => {
    const end = start + node.data.length;
    const last = index === nodes.length - 1;
    const frag = document.createDocumentFragment();
    const emitDeleted = (at: number) => {
      while (di < deleted.length && deleted[di].at <= at) frag.append(tag('del', 'rm-del', deleted[di++].text));
    };
    let p = start;
    while (p < end) {
      emitDeleted(p);
      while (ii < inserted.length && inserted[ii][1] <= p) ii++;
      const ins = ii < inserted.length && inserted[ii][0] <= p;
      let stop = Math.min(end, ins ? inserted[ii][1] : ii < inserted.length ? inserted[ii][0] : end);
      if (di < deleted.length && deleted[di].at > p) stop = Math.min(stop, deleted[di].at);
      const text = node.data.slice(p - start, stop - start);
      frag.append(ins ? tag('ins', 'rm-ins', text) : document.createTextNode(text));
      p = stop;
    }
    if (last) emitDeleted(total);
    start = end;
    node.replaceWith(frag);
  });
}

function tag(name: 'ins' | 'del', className: string, text: string): HTMLElement {
  const el = document.createElement(name);
  el.className = className;
  el.textContent = text;
  return el;
}

// ---- helpers --------------------------------------------------------------------------------

function mark(el: HTMLElement, cls: string, ctx: Context): void {
  el.classList.add(cls);
  ctx.marks++;
}

/** A copy of an original element for display only: no source positions, ids or live controls. */
function cloneRemoved(el: HTMLElement, cls: string): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const attr of STRIP_ATTRS) node.removeAttribute(attr);
  }
  for (const input of clone.querySelectorAll('input')) input.disabled = true;
  clone.classList.add(cls);
  clone.setAttribute('aria-label', cls === 'rm-chg-del' ? 'Removed' : 'Moved from here');
  return clone;
}

/** Gutter mode: remember that content was removed in front of `before` (or after `last`). */
function markRemovedAt(root: HTMLElement, before: HTMLElement | null, last?: HTMLElement): void {
  if (before) before.dataset.rmDelBefore = '';
  else {
    const target = last ?? (root.lastElementChild as HTMLElement | null) ?? root;
    target.dataset.rmDelAfter = '';
  }
}
