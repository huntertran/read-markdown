// Pure helpers for in-preview block editing. No `vscode` imports so they can be unit-tested.

/** True if [start, end) is a non-empty range of whole lines inside a document of `lineCount` lines. */
export function isValidBlockRange(start: unknown, end: unknown, lineCount: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 0 &&
    (end as number) > (start as number) &&
    (end as number) <= lineCount
  );
}

// List item with a task marker, optionally inside blockquotes: `- [ ] a`, `> 1. [x] b`, and the
// in-progress markers `[/]`, `[~]`, `[-]` (see `ACTIVE_TASK_MARKERS` in render/markdown.ts).
const TASK_MARKER = /^((?:[ \t]*>)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[)[ xX/~-]\]/;

/** Column of the state character (` `, `x`, `X`, or in progress `/`, `~`, `-`) in a task list item line, or undefined. */
export function taskMarkerColumn(line: string): number | undefined {
  const m = TASK_MARKER.exec(line);
  return m ? m[1].length : undefined;
}

const TRAILING_BREAKS =/(?:\r\n|\r|\n)+$/;

/**
 * Source text as shown in the edit box: `\n` line endings, without the block's trailing line
 * breaks (some blocks, e.g. lists, include the blank line after them in their range).
 */
export function toEditText(source: string): string {
  return source.replace(TRAILING_BREAKS, '').replace(/\r\n?/g, '\n');
}

/**
 * Turns the edit box text back into the replacement for the original block source: converts line
 * endings to the document's `eol` and re-appends the original's trailing line breaks verbatim, so
 * the block stays separated from the next one exactly as before (and a file without a trailing
 * newline keeps none). An empty edit deletes the block.
 */
export function toReplacement(original: string, edited: string, eol: '\n' | '\r\n'): string {
  const text = edited.replace(TRAILING_BREAKS, '').replace(/\r\n?/g, '\n');
  if (!text) return '';
  const body = eol === '\n' ? text : text.replace(/\n/g, eol);
  return body + (TRAILING_BREAKS.exec(original)?.[0] ?? '');
}
