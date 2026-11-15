// Wires `GitBaseline` to VS Code: the built-in Git extension and a real event emitter.
import * as vscode from 'vscode';
import { GitBaseline, type GitExtension } from './gitBaseline';

export function createGitBaseline(): GitBaseline {
  return new GitBaseline({
    getGitExtension: () => vscode.extensions.getExtension<GitExtension>('vscode.git'),
    createEmitter: () => new vscode.EventEmitter<vscode.Uri | undefined>(),
  });
}
