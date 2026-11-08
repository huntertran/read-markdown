// Pure sequence/word diff helpers. Shared by the extension (block alignment) and the webview
// (child alignment and word-level changes), so no `vscode` or DOM imports here.

export type Edit = { op: 'eq'; a: number; b: number } | { op: 'del'; a: number } | { op: 'ins'; b: number };

/** Default cap on the LCS table size (after trimming the common prefix/suffix). */
const MAX_CELLS = 4_000_000;

/**
 * Shortest edit script from `a` to `b` (LCS based). Within each changed run deletions come before
 * insertions. Returns undefined when the changed middle is too large to diff (`maxCells`).
 */
export function diffSequences<T>(
  a: readonly T[],
  b: readonly T[],
  eq: (x: T, y: T) => boolean = (x, y) => x === y,
  maxCells = MAX_CELLS,
): Edit[] | undefined {
  let start = 0;
  while (start < a.length && start < b.length && eq(a[start], b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > maxCells) return undefined;

  const edits: Edit[] = [];
  for (let i = 0; i < start; i++) edits.push({ op: 'eq', a: i, b: i });

  if (n === 0 || m === 0) {
    for (let i = start; i < endA; i++) edits.push({ op: 'del', a: i });
    for (let j = start; j < endB; j++) edits.push({ op: 'ins', b: j });
  } else {
    // lcs[i][j] = LCS length of a[start+i..endA) and b[start+j..endB), stored row-major.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = eq(a[start + i], b[start + j])
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    const dels: Edit[] = [];
    const inses: Edit[] = [];
    const flush = () => {
      edits.push(...dels, ...inses);
      dels.length = 0;
      inses.length = 0;
    };
    while (i < n || j < m) {
      if (i < n && j < m && eq(a[start + i], b[start + j])) {
        flush();
        edits.push({ op: 'eq', a: start + i, b: start + j });
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        dels.push({ op: 'del', a: start + i });
        i++;
      } else {
        inses.push({ op: 'ins', b: start + j });
        j++;
      }
    }
    flush();
  }

  for (let i = endA, j = endB; i < a.length; i++, j++) edits.push({ op: 'eq', a: i, b: j });
  return edits;
}

const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/** Splits text into words, whitespace runs and single punctuation marks (CJK: one per character). */
export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Splits text into lines, each keeping its trailing newline. */
export function tokenizeLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export interface WordChange {
  op: 'eq' | 'ins' | 'del';
  text: string;
}

/**
 * Token diff of `a` → `b`, merged into runs. Whitespace-only equal runs between two changes are
 * folded into the changes so a rewritten phrase reads as one deletion and one insertion.
 * Returns undefined when the texts are too large to diff.
 */
export function diffTokens(a: readonly string[], b: readonly string[]): WordChange[] | undefined {
  const edits = diffSequences(a, b);
  if (!edits) return undefined;
  const raw: WordChange[] = edits.map((e) =>
    e.op === 'eq' ? { op: 'eq', text: b[e.b] } : e.op === 'del' ? { op: 'del', text: a[e.a] } : { op: 'ins', text: b[e.b] },
  );
  // Fold whitespace-only eq tokens that sit between changes on both sides.
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i].op !== 'eq' || /\S/.test(raw[i].text)) continue;
    const prev = raw[i - 1].op;
    let k = i + 1;
    while (k < raw.length && raw[k].op === 'eq' && !/\S/.test(raw[k].text)) k++;
    if (prev !== 'eq' && k < raw.length && raw[k].op !== 'eq') {
      const ws = raw.slice(i, k).map((r) => r.text).join('');
      raw.splice(i, k - i, { op: 'del', text: ws }, { op: 'ins', text: ws });
      i++;
    }
  }
  return mergeRuns(raw);
}

/** Merges adjacent runs; within a changed stretch, all deletions come before all insertions. */
function mergeRuns(raw: readonly WordChange[]): WordChange[] {
  const out: WordChange[] = [];
  let del = '';
  let ins = '';
  const flush = () => {
    if (del) out.push({ op: 'del', text: del });
    if (ins) out.push({ op: 'ins', text: ins });
    del = '';
    ins = '';
  };
  for (const r of raw) {
    if (r.op === 'del') del += r.text;
    else if (r.op === 'ins') ins += r.text;
    else {
      flush();
      const last = out.at(-1);
      if (last?.op === 'eq') last.text += r.text;
      else out.push({ op: 'eq', text: r.text });
    }
  }
  flush();
  return out;
}

/** Word-level diff of two strings. */
export function diffWords(a: string, b: string): WordChange[] | undefined {
  return diffTokens(tokenize(a), tokenize(b));
}

/** Collapses whitespace runs and trims, for comparing text that may be reflowed. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface TokenBag {
  counts: Map<string, number>;
  size: number;
}

/** Non-whitespace token counts, for the order-insensitive {@link bagSimilarity}. */
export function tokenBag(text: string): TokenBag {
  const counts = new Map<string, number>();
  let size = 0;
  for (const t of tokenize(text)) {
    if (!/\S/.test(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
    size++;
  }
  return { counts, size };
}

/** Dice coefficient of two token bags (2·shared / total), 0..1; two empty bags are identical. */
export function bagSimilarity(a: TokenBag, b: TokenBag): number {
  if (a.size === 0 && b.size === 0) return 1;
  const [small, large] = a.counts.size <= b.counts.size ? [a, b] : [b, a];
  let shared = 0;
  for (const [t, c] of small.counts) shared += Math.min(c, large.counts.get(t) ?? 0);
  return (2 * shared) / (a.size + b.size);
}

/**
 * Share of non-whitespace tokens the two texts have in common (2·LCS / total), 0..1.
 * Two empty texts are identical (1). Too large to diff → 0.
 */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a).filter((t) => /\S/.test(t));
  const tb = tokenize(b).filter((t) => /\S/.test(t));
  if (ta.length === 0 && tb.length === 0) return 1;
  const edits = diffSequences(ta, tb, undefined, 1_000_000);
  if (!edits) return 0;
  const common = edits.filter((e) => e.op === 'eq').length;
  return (2 * common) / (ta.length + tb.length);
}
