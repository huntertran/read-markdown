// Aligns two block sequences (top-level Markdown blocks, or list items / rows inside one block)
// into insert / delete / modify / move operations. Pure: used by the extension and the webview.
import type { BlockChange } from '../protocol';
import { bagSimilarity, diffSequences, normalize, similarity, tokenBag } from './textDiff';

export interface AlignItem {
  /** Block type; only blocks of the same kind are paired as modified or moved. */
  kind: string;
  /** Text compared for similarity (modify / move pairing). */
  text: string;
  /** Identity for "unchanged" when it differs from `text` (e.g. markup incl. link targets); default `text`. */
  key?: string;
}

/**
 * Index-based operations. `before` is the index in the new sequence that a removed item is shown
 * in front of (`new.length` = after the last item). Unchanged items get no operation.
 */
export type AlignOp =
  | { op: 'ins'; b: number }
  | { op: 'del'; a: number; before: number }
  | { op: 'modify'; a: number; b: number }
  | { op: 'moveFrom'; a: number; before: number; id: number }
  | { op: 'moveTo'; a: number; b: number; id: number; edited: boolean };

export interface AlignOptions {
  /** Minimum similarity to show a changed item as modified rather than removed + added. */
  modifyThreshold?: number;
  /** Minimum similarity to show a removed + added pair as moved. */
  moveThreshold?: number;
  /** Shorter normalized texts are never treated as moved (e.g. `---`, a one-word item). */
  moveMinLength?: number;
  /** Max pairwise comparisons for fuzzy move detection; beyond it only exact moves are found. */
  maxMoveComparisons?: number;
  /** First move id to hand out (lets callers keep ids unique across nested alignments). */
  firstMoveId?: number;
}

const DEFAULTS: Required<AlignOptions> = {
  modifyThreshold: 0.5,
  moveThreshold: 0.85,
  moveMinLength: 12,
  maxMoveComparisons: 2500,
  firstMoveId: 0,
};

/** Returns undefined when the sequences are too large to diff. */
export function alignBlocks(oldItems: readonly AlignItem[], newItems: readonly AlignItem[], options: AlignOptions = {}): AlignOp[] | undefined {
  const o = { ...DEFAULTS, ...options };
  const matches = matchItems(oldItems, newItems, o.modifyThreshold);
  if (!matches) return undefined;

  const ops: AlignOp[] = [];
  const unpairedDel: { a: number; before: number }[] = [];
  const unpairedIns: number[] = [];

  // Unmatched items sit in the gaps between matches. Removed ones are shown first in their gap
  // (right after the new counterpart of the previous match), like Word: old text, then new text.
  let prevA = -1;
  let prevB = -1;
  for (const [a, b] of [...matches, [oldItems.length, newItems.length] as const]) {
    for (let i = prevA + 1; i < a; i++) unpairedDel.push({ a: i, before: prevB + 1 });
    for (let j = prevB + 1; j < b; j++) unpairedIns.push(j);
    if (a < oldItems.length && !same(oldItems[a], newItems[b])) ops.push({ op: 'modify', a, b });
    prevA = a;
    prevB = b;
  }

  // Moves: a removed and an added item (anywhere in the document) with (nearly) the same text.
  const norm = (it: AlignItem) => normalize(it.text);
  const delTaken = new Set<number>();
  const fuzzy = unpairedDel.length * unpairedIns.length <= o.maxMoveComparisons;
  const exact = new Map<string, number[]>(); // kind + text -> indices into unpairedDel
  unpairedDel.forEach((d, i) => {
    const key = `${oldItems[d.a].kind}\u0000${norm(oldItems[d.a])}`;
    exact.set(key, [...(exact.get(key) ?? []), i]);
  });
  let id = o.firstMoveId;
  const moved = new Set<number>();
  for (const b of unpairedIns) {
    const text = norm(newItems[b]);
    if (text.length < o.moveMinLength) continue;
    let best: number | undefined = (exact.get(`${newItems[b].kind}\u0000${text}`) ?? []).find((i) => !delTaken.has(i));
    let edited = false;
    if (best === undefined && fuzzy) {
      let bestScore = o.moveThreshold;
      for (let i = 0; i < unpairedDel.length; i++) {
        const d = unpairedDel[i];
        if (delTaken.has(i) || oldItems[d.a].kind !== newItems[b].kind) continue;
        const s = similarity(oldItems[d.a].text, newItems[b].text);
        if (s >= bestScore) {
          bestScore = s;
          best = i;
          edited = true;
        }
      }
    }
    if (best === undefined) continue;
    delTaken.add(best);
    moved.add(b);
    const d = unpairedDel[best];
    ops.push({ op: 'moveFrom', a: d.a, before: d.before, id }, { op: 'moveTo', a: d.a, b, id, edited });
    id++;
  }

  unpairedDel.forEach((d, i) => {
    if (!delTaken.has(i)) ops.push({ op: 'del', a: d.a, before: d.before });
  });
  for (const b of unpairedIns) if (!moved.has(b)) ops.push({ op: 'ins', b });

  // Removed items last and in old order, so ones sharing a `before` are inserted in source order.
  return ops.sort((x, y) => orderKey(x) - orderKey(y));
}

function same(x: AlignItem, y: AlignItem): boolean {
  return x.kind === y.kind && (x.key ?? x.text) === (y.key ?? y.text);
}

/** Largest changed middle (old × new items) aligned by similarity; beyond it, exact LCS only. */
const MAX_WEIGHTED_CELLS = 250_000;

/**
 * Order-preserving matches `[oldIndex, newIndex]` (unchanged or modified pairs), ascending.
 *
 * Plain LCS on exact text lets one unchanged block anchor the alignment even when that strands
 * several edited blocks on opposite sides of it (e.g. a paragraph moved past four edited ones).
 * So the changed middle is aligned by total similarity instead: an identical pair scores 1, a
 * same-kind pair with word-bag similarity ≥ `threshold` scores that similarity (< 1).
 */
function matchItems(oldItems: readonly AlignItem[], newItems: readonly AlignItem[], threshold: number): [number, number][] | undefined {
  const matches: [number, number][] = [];
  let start = 0;
  while (start < oldItems.length && start < newItems.length && same(oldItems[start], newItems[start])) {
    matches.push([start, start]);
    start++;
  }
  let endA = oldItems.length;
  let endB = newItems.length;
  const suffix: [number, number][] = [];
  while (endA > start && endB > start && same(oldItems[endA - 1], newItems[endB - 1])) {
    endA--;
    endB--;
    suffix.unshift([endA, endB]);
  }
  const n = endA - start;
  const m = endB - start;

  if (n > 0 && m > 0) {
    if (n * m <= MAX_WEIGHTED_CELLS) {
      matches.push(...weightedMatches(oldItems.slice(start, endA), newItems.slice(start, endB), threshold).map(([a, b]) => [a + start, b + start] as [number, number]));
    } else {
      const edits = diffSequences(oldItems.slice(start, endA), newItems.slice(start, endB), same);
      if (!edits) return undefined;
      for (const e of edits) if (e.op === 'eq') matches.push([e.a + start, e.b + start]);
    }
  }
  return [...matches, ...suffix];
}

function weightedMatches(a: readonly AlignItem[], b: readonly AlignItem[], threshold: number): [number, number][] {
  const n = a.length;
  const m = b.length;
  const bagsA = a.map((x) => tokenBag(x.text));
  const bagsB = b.map((y) => tokenBag(y.text));
  const score = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (a[i].kind !== b[j].kind) continue;
      if (same(a[i], b[j])) score[i * m + j] = 1;
      else {
        const s = bagSimilarity(bagsA[i], bagsB[j]);
        // Just below an identical pair, so identical wins a tie.
        if (s >= threshold) score[i * m + j] = Math.min(s, 0.999);
      }
    }
  }
  // best[i][j] = max total score aligning a[i..] with b[j..].
  const w = m + 1;
  const best = new Float64Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = score[i * m + j];
      best[i * w + j] = Math.max(best[(i + 1) * w + j], best[i * w + j + 1], s > 0 ? s + best[(i + 1) * w + j + 1] : 0);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const s = score[i * m + j];
    if (s > 0 && best[i * w + j] === s + best[(i + 1) * w + j + 1]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (best[i * w + j] === best[(i + 1) * w + j]) i++;
    else j++;
  }
  return out;
}

function orderKey(op: AlignOp): number {
  return op.op === 'del' || op.op === 'moveFrom' ? op.a + 1 : 0;
}

/** A top-level block of a rendered document (see `RenderResult.topBlocks`). */
export interface SourceBlock extends AlignItem {
  /** 0-based first source line (`data-line`). */
  line: number;
  /** Exclusive end line (`data-line-end`). */
  end: number;
}

/** Top-level block changes from `original` to `current`; undefined when too large to diff. */
export function diffDocument(original: readonly SourceBlock[], current: readonly SourceBlock[]): BlockChange[] | undefined {
  const ops = alignBlocks(original, current);
  if (!ops) return undefined;
  const lineOf = (b: number) => (b < current.length ? current[b].line : null);
  return ops.map((op): BlockChange => {
    switch (op.op) {
      case 'ins':
        return { op: 'ins', line: current[op.b].line };
      case 'del':
        return { op: 'del', oldLine: original[op.a].line, before: lineOf(op.before) };
      case 'modify':
        return { op: 'modify', oldLine: original[op.a].line, line: current[op.b].line };
      case 'moveFrom':
        return { op: 'moveFrom', oldLine: original[op.a].line, before: lineOf(op.before), id: op.id };
      case 'moveTo':
        return { op: 'moveTo', oldLine: original[op.a].line, line: current[op.b].line, id: op.id, edited: op.edited };
    }
  });
}
