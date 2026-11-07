// Pure helpers for reordering sibling list items in Markdown source (no `vscode` import, so they
// are unit-testable). An item spans from its start line to the next sibling's start line; the
// last one ends at the list's end line. Blank lines at the end of an item are separators that
// stay in place, so a loose list stays loose and the blank line after the list stays put.

/** Start of a list item line: optional indent, then a bullet or an ordered marker. */
const ITEM_START = /^([ \t]*)([-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const ORDERED = /^([ \t]*)(\d{1,9})([.)])/;
const BLANK = /^[ \t]*$/;

export interface ListMoveResult {
  /** Number of lines replaced, starting at the first item's start line. */
  count: number;
  /** Replacement lines (without line breaks). */
  lines: string[];
  /** Offset of the moved item's first line from the first item's start line, after the move. */
  movedOffset: number;
}

/**
 * Moves item `from` to position `to` among sibling list items.
 *
 * `lines` are the source lines from the first item's start line up to `end` (exclusive), and
 * `starts` the items' start lines relative to that first line (so `starts[0]` is 0). Returns
 * undefined if the input does not describe one list of sibling items.
 */
export function moveListItem(lines: readonly string[], starts: readonly number[], from: number, to: number): ListMoveResult | undefined {
  const n = starts.length;
  if (n < 2 || starts[0] !== 0 || !isIndex(from, n) || !isIndex(to, n) || from === to) return undefined;
  for (let i = 1; i < n; i++) {
    if (!Number.isInteger(starts[i]) || starts[i] <= starts[i - 1]) return undefined;
  }
  if (starts[n - 1] >= lines.length) return undefined;

  // Every item must start with a marker at the same indent, all bullets or all numbers.
  const markers = starts.map((s) => ITEM_START.exec(lines[s]));
  if (markers.some((m) => !m)) return undefined;
  const indent = markers[0]![1];
  const ordered = /\d/.test(markers[0]![2]);
  if (markers.some((m) => m![1] !== indent || /\d/.test(m![2]) !== ordered)) return undefined;

  const contents: string[][] = [];
  const separators: string[][] = [];
  for (let i = 0; i < n; i++) {
    const chunk = lines.slice(starts[i], i + 1 < n ? starts[i + 1] : lines.length);
    let k = chunk.length;
    while (k > 1 && BLANK.test(chunk[k - 1])) k--;
    contents.push(chunk.slice(0, k));
    separators.push(chunk.slice(k));
  }

  const order = contents.map((_, i) => i);
  order.splice(from, 1);
  order.splice(to, 0, from);

  const out: string[] = [];
  let movedOffset = 0;
  order.forEach((src, pos) => {
    if (src === from) movedOffset = out.length;
    const item = [...contents[src]];
    // Keep each position's number, so "1. 2. 3." stays in order (and "1. 1. 1." stays as is).
    if (ordered) item[0] = item[0].replace(ORDERED, (_m, ws: string, _num: string, delim: string) => `${ws}${numberAt(lines, starts[pos])}${delim}`);
    out.push(...item);
    // Separators stay with their position; the last item's trailing blanks are not replaced.
    if (pos < n - 1) out.push(...separators[pos]);
  });

  return { count: lines.length - separators[n - 1].length, lines: out, movedOffset };
}

function isIndex(i: number, n: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < n;
}

function numberAt(lines: readonly string[], start: number): string {
  return ORDERED.exec(lines[start])?.[2] ?? '';
}
