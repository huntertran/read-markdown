import * as path from 'node:path';
import * as vscode from 'vscode';

/** Loads `readMarkdown.customCss.files` + inline CSS and watches the files for changes. */
export class CustomCssProvider implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private watchers: vscode.Disposable[] = [];
  private files: vscode.Uri[] = [];
  private inline = '';
  private cache: Promise<string> | undefined;

  configure(files: string[], inline: string): void {
    const uris = files.map((f) => this.resolve(f)).filter((u): u is vscode.Uri => !!u);
    const same = uris.length === this.files.length && uris.every((u, i) => u.toString() === this.files[i].toString());
    if (same && inline === this.inline && this.cache) return;
    this.inline = inline;
    if (!same) {
      this.files = uris;
      this.disposeWatchers();
      for (const uri of uris) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)),
        );
        const changed = () => this.invalidate();
        watcher.onDidChange(changed);
        watcher.onDidCreate(changed);
        watcher.onDidDelete(changed);
        this.watchers.push(watcher);
      }
    }
    this.invalidate();
  }

  get(): Promise<string> {
    this.cache ??= this.load();
    return this.cache;
  }

  private async load(): Promise<string> {
    const parts: string[] = [];
    for (const uri of this.files) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        parts.push(`/* ${path.basename(uri.fsPath)} */\n${new TextDecoder().decode(bytes)}`);
      } catch {
        parts.push(`/* Read Markdown: could not read ${uri.fsPath} */`);
      }
    }
    if (this.inline.trim()) parts.push(`/* readMarkdown.customCss.inline */\n${this.inline}`);
    return parts.join('\n\n');
  }

  private invalidate(): void {
    this.cache = undefined;
    this.emitter.fire();
  }

  private resolve(file: string): vscode.Uri | undefined {
    if (!file?.trim()) return undefined;
    let p = file.trim();
    if (p.startsWith('~')) p = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', p.slice(1));
    if (path.isAbsolute(p)) return vscode.Uri.file(p);
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, p) : undefined;
  }

  private disposeWatchers(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
  }

  dispose(): void {
    this.disposeWatchers();
    this.emitter.dispose();
  }
}
