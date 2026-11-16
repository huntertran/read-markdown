// Viewport-first render: a long document is shown in two parts. The first part (every block from the
// start through the scroll target, plus a margin) is sanitized, laid out and painted alone; the rest is
// added right after the first frame (app.ts). Pure (no DOM) apart from reading block attributes.
import type { RawBlocks } from './patch';

/** Below these sizes a document renders in one go: splitting would not show it noticeably sooner. */
export const MIN_BLOCKS = 150;
export const MIN_CHARS = 60_000;
/** Source lines after the scroll target in the first part: more than a screen, whatever the line height. */
export const MARGIN_LINES = 200;
/** The rest must hold at least this share of the document, else one render is cheaper. */
export const MIN_REST_SHARE = 0.25;

export interface Split {
  /** Index of the first block of the rest. */
  at: number;
  /** 0-based source line where the rest starts (`-Infinity` if its first block has none). */
  restLine: number;
}

const lineOf = (el: Element) => Number(el.getAttribute('data-line') ?? NaN);

/** Where to split `blocks` for a first part that covers `targetLine` (the line at the top of the view). */
export function splitPoint(blocks: RawBlocks, targetLine: number): Split | undefined {
  const n = blocks.elements.length;
  const chars = blocks.html.reduce((sum, h) => sum + h.length, 0);
  if (n < MIN_BLOCKS || chars < MIN_CHARS) return undefined;
  const limit = targetLine + MARGIN_LINES;
  let at = 0;
  // A block without a line (e.g. the footnotes) stays with the blocks before it.
  while (at < n && !(lineOf(blocks.elements[at]) > limit)) at++;
  if (at >= n) return undefined;
  let rest = 0;
  for (let i = at; i < n; i++) rest += blocks.html[i].length;
  if (rest < chars * MIN_REST_SHARE) return undefined;
  const line = lineOf(blocks.elements[at]);
  return { at, restLine: Number.isNaN(line) ? -Infinity : line };
}
