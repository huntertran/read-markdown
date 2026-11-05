// Pure helpers that turn a source-editor selection into a preview search term.

export const MAX_TERM_LENGTH = 200;

const WRAPPERS = ['**', '__', '~~', '`', '*', '_'];
const LINE_PREFIX = /^(?:#{1,6}\s+|>\s*|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/;

export interface SearchTerm {
  term: string;
  /** Offset of `term` inside the original selected text. */
  offset: number;
}

/**
 * Derives the text to highlight from the selected source text.
 * Returns undefined when nothing should be highlighted (empty, multi-line, too short/long).
 * Markdown syntax wrapping the selection (`**bold**`, `` `code` ``, `# heading`) is stripped
 * so it matches the rendered text.
 */
export function searchTermFromSelection(selected: string, minLength: number): SearchTerm | undefined {
  if (!selected || /[\r\n]/.test(selected)) return undefined;

  let start = 0;
  let end = selected.length;
  const trimWhitespace = () => {
    while (start < end && /\s/.test(selected[start])) start++;
    while (end > start && /\s/.test(selected[end - 1])) end--;
  };

  trimWhitespace();
  const prefix = LINE_PREFIX.exec(selected.slice(start, end));
  if (prefix && prefix[0].length < end - start) {
    start += prefix[0].length;
    trimWhitespace();
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const w of WRAPPERS) {
      if (end - start > w.length * 2 && selected.startsWith(w, start) && selected.endsWith(w, end)) {
        start += w.length;
        end -= w.length;
        trimWhitespace();
        changed = true;
        break;
      }
    }
  }

  const term = selected.slice(start, end);
  if (term.length < Math.max(1, minLength) || term.length > MAX_TERM_LENGTH) return undefined;
  return { term, offset: start };
}

/** Number of non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string, caseSensitive: boolean): number {
  if (!needle) return 0;
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  let count = 0;
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) count++;
  return count;
}

/** Largest entry of sorted `blockLines` that is <= `line`, or 0 when there is none. */
export function blockStartFor(blockLines: readonly number[], line: number): number {
  let lo = 0;
  let hi = blockLines.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blockLines[mid] <= line) {
      found = blockLines[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
