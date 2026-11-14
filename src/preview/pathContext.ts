import * as vscode from 'vscode';
import { type PathContext, type UriParts, hostPathFlags } from './paths';

/** What `paths.ts` needs to resolve references written in `document`, read from the current workspace. */
export function pathContextFor(document: vscode.Uri, relativeBase?: PathContext['relativeBase']): PathContext {
  return {
    document,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ...hostPathFlags(),
    relativeBase,
  };
}

export function toUri(parts: UriParts): vscode.Uri {
  return vscode.Uri.from({ scheme: parts.scheme, authority: parts.authority, path: parts.path });
}
