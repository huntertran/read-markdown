import * as vscode from 'vscode';
import type { EditError } from '../protocol';
import { isValidBlockRange, taskMarkerColumn, toEditText, toReplacement } from './blockText';
import { moveListItem } from './listMove';

export type BlockSourceResult = { text: string } | { error: EditError };
export type BlockEditResult = { ok: true } | { ok: false; error: EditError };
export type ListMoveEditResult = { ok: true; line: number } | { ok: false; error: EditError };

function blockRange(document: vscode.TextDocument, start: number, end: number): vscode.Range {
  // `end` may equal lineCount (block on the last line without trailing newline); validateRange
  // clamps that to the end of the document.
  return document.validateRange(new vscode.Range(start, 0, end, 0));
}

function isReadonly(document: vscode.TextDocument): boolean {
  return vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === false;
}

function check(document: vscode.TextDocument, start: unknown, end: unknown, docVersion: unknown): EditError | undefined {
  if (document.version !== docVersion) return 'stale';
  if (!isValidBlockRange(start, end, document.lineCount)) return 'invalid';
  if (isReadonly(document)) return 'readonly';
  return undefined;
}

/** Source of lines [start, end) as shown in the preview's edit box. */
export function readBlock(document: vscode.TextDocument, start: number, end: number, docVersion: number): BlockSourceResult {
  const error = check(document, start, end, docVersion);
  if (error) return { error };
  return { text: toEditText(document.getText(blockRange(document, start, end))) };
}

/**
 * Replaces lines [start, end) with `text` via a WorkspaceEdit (so it is undoable and marks the
 * document dirty), but only if the document is still at `docVersion`.
 */
export async function applyBlockEdit(
  document: vscode.TextDocument,
  start: number,
  end: number,
  docVersion: number,
  text: string,
): Promise<BlockEditResult> {
  if (typeof text !== 'string') return { ok: false, error: 'invalid' };
  const error = check(document, start, end, docVersion);
  if (error) return { ok: false, error };
  const range = blockRange(document, start, end);
  const original = document.getText(range);
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const replacement = toReplacement(original, text, eol);
  if (replacement === original) return { ok: true };
  return replace(document, range, replacement);
}

/**
 * Checks or unchecks the task list item on `line` by rewriting only its `[ ]` / `[x]` state
 * character, if the document is still at `docVersion`. In-progress items (`[/]`, `[~]`, `[-]`) count
 * as unchecked: checking one marks it done.
 */
export async function toggleTask(
  document: vscode.TextDocument,
  line: number,
  checked: boolean,
  docVersion: number,
): Promise<BlockEditResult> {
  if (typeof checked !== 'boolean') return { ok: false, error: 'invalid' };
  const error = check(document, line, typeof line === 'number' ? line + 1 : line, docVersion);
  if (error) return { ok: false, error };
  const column = taskMarkerColumn(document.lineAt(line).text);
  if (column === undefined) return { ok: false, error: 'invalid' };
  const range = new vscode.Range(line, column, line, column + 1);
  const current = /[xX]/.test(document.getText(range));
  if (current === checked) return { ok: true };
  return replace(document, range, checked ? 'x' : ' ');
}

/**
 * Moves list item `from` to position `to` among the sibling items starting at source lines
 * `starts` (the last one ending at `end`), if the document is still at `docVersion`. Returns the
 * moved item's new start line.
 */
export async function moveListItemEdit(
  document: vscode.TextDocument,
  starts: number[],
  end: number,
  from: number,
  to: number,
  docVersion: number,
): Promise<ListMoveEditResult> {
  if (!Array.isArray(starts) || starts.length < 2) return { ok: false, error: 'invalid' };
  const first = starts[0];
  const error = check(document, first, end, docVersion);
  if (error) return { ok: false, error };
  const lines: string[] = [];
  for (let i = first; i < end; i++) lines.push(document.lineAt(i).text);
  const moved = moveListItem(lines, starts.map((s) => (typeof s === 'number' ? s - first : NaN)), from, to);
  if (!moved) return { ok: false, error: 'invalid' };
  const last = first + moved.count - 1;
  const range = new vscode.Range(first, 0, last, document.lineAt(last).text.length);
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const result = await replace(document, range, moved.lines.join(eol));
  return result.ok ? { ok: true, line: first + moved.movedOffset } : result;
}

async function replace(document: vscode.TextDocument, range: vscode.Range, text: string): Promise<BlockEditResult> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, text);
  try {
    return (await vscode.workspace.applyEdit(edit)) ? { ok: true } : { ok: false, error: 'failed' };
  } catch {
    return { ok: false, error: 'failed' };
  }
}
