// Parses the input of `readMarkdown.goToLine`. Pure: no `vscode` import, unit-tested.

/** Accepts `42`, `42:7` or `42,7` like VS Code's Go to Line (the column is ignored); `:` may lead. */
const LINE_INPUT = /^:?\s*(\d+)(?:\s*[:,]\s*\d*)?\s*$/;

/** The 0-based line for a 1-based input, clamped to the document like VS Code does; undefined if not a line. */
export function parseLineInput(text: string, lineCount: number): number | undefined {
  const m = LINE_INPUT.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n)) return undefined;
  return Math.max(0, Math.min(Math.max(lineCount, 1), n) - 1);
}

/** The input box validation message, or undefined when the text is a line (an empty box shows no error). */
export function lineInputError(text: string, lineCount: number): string | undefined {
  if (text.trim() === '' || parseLineInput(text, lineCount) !== undefined) return undefined;
  return `Type a line number between 1 and ${Math.max(lineCount, 1)}.`;
}
