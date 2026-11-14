// Checks edit requests from the webview against what the renderer actually produced. The webview is
// untrusted: raw HTML in a document could carry forged `data-line` attributes, so the host accepts a
// range only if it is one the renderer itself emitted for the document version the message cites.
// Pure (no `vscode` import) so it is unit-testable; `PreviewPanel` supplies the ranges of its last render.

/** A top-level block as collected by the renderer (`RenderResult.topBlocks`); `end` is exclusive. */
export interface BlockRange {
  line: number;
  end: number;
  kind: string;
}

/**
 * The items of one rendered list with two or more items: the start line of each (`data-line`) in
 * order, and the exclusive end line of the last one (its `data-item-end`).
 */
export interface ListRange {
  starts: number[];
  end: number;
}

/**
 * True if [start, end) is exactly one top-level block the renderer marked with `data-line-end`.
 * Raw HTML blocks are not: they render without line attributes, so the preview cannot edit them.
 */
export function isRenderedBlock(blocks: readonly BlockRange[], start: unknown, end: unknown): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  return blocks.some((b) => b.line === start && b.end === end && b.kind !== 'html_block');
}

/**
 * True if `line` is the start line of a task list item the renderer rendered with a checkbox.
 */
export function isRenderedTaskLine(taskLines: readonly number[], line: unknown): boolean {
  if (!Number.isInteger(line)) return false;
  return taskLines.includes(line as number);
}

/**
 * True if `starts` are exactly all the items of one rendered list (siblings under the same parent, in
 * order, none missing: the preview sends every item of the list) and `end` is where its last item ends.
 */
export function isRenderedListMove(lists: readonly ListRange[], starts: unknown, end: unknown): boolean {
  if (!Array.isArray(starts) || starts.length < 2 || !Number.isInteger(end)) return false;
  return lists.some(
    (list) => list.end === end && list.starts.length === starts.length && list.starts.every((s, i) => s === starts[i]),
  );
}
