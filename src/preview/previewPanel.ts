import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyBlockEdit, readBlock, toggleTask } from '../edit/blockEdit';
import type { FromWebview, ToWebview } from '../protocol';
import type { RenderResult } from '../render/markdown';
import { blockStartFor, countOccurrences, searchTermFromSelection } from '../sync/selection';
import { getWebviewHtml } from './html';
import type { PreviewManager } from './previewManager';

export const PREVIEW_VIEW_TYPE = 'readMarkdown.preview';
const RENDER_DEBOUNCE_MS = 250;

/** One preview webview bound to one Markdown document. */
export class PreviewPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRender: RenderResult | undefined;
  private lastHighlightKey = '';
  private pendingLine: number | undefined;
  /** Set while hidden; VS Code may wrongly re-show a closed find widget when the panel returns. */
  private findMayBeStale = false;
  /** Ignore webview-originated scroll messages until this time (ms) to avoid feedback loops. */
  ignorePreviewScrollUntil = 0;

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.emitter.event;

  constructor(
    readonly panel: vscode.WebviewPanel,
    private document: vscode.TextDocument,
    private readonly manager: PreviewManager,
    readonly kind: 'panel' | 'editor',
  ) {
    this.configureWebview();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(({ webviewPanel }) => {
        if (!webviewPanel.visible) this.findMayBeStale = true;
        if (webviewPanel.active) {
          manager.setActive(this);
          if (this.findMayBeStale) {
            this.findMayBeStale = false;
            // VS Code bug: closing the webview find widget from inside it (× button, possibly Escape) does not reset the
            // `webviewFindWidgetVisible` context key, so the widget is re-shown when the hidden
            // webview is restored. Close it again; the command only acts on the active webview.
            // https://github.com/microsoft/vscode/issues/307943
            // TODO: remove this workaround (and `findMayBeStale`) once `engines.vscode` >= the fixed version.
            void vscode.commands.executeCommand('editor.action.webvieweditor.hideFind');
          }
        }
      }),
    );

    // Refresh when the file changes on disk even if no editor has it open (e.g. an AI agent rewriting it).
    if (document.uri.scheme === 'file') {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(document.uri.fsPath)), path.basename(document.uri.fsPath)),
        true,
        false,
        true,
      );
      watcher.onDidChange(() => this.scheduleRender());
      this.disposables.push(watcher);
    }
  }

  get uri(): vscode.Uri {
    return this.document.uri;
  }

  get blockLines(): readonly number[] {
    return this.lastRender?.blockLines ?? [];
  }

  matches(uri: vscode.Uri): boolean {
    return this.document.uri.toString() === uri.toString();
  }

  private configureWebview(): void {
    const ext = this.manager.extensionUri;
    const roots = [vscode.Uri.joinPath(ext, 'media'), vscode.Uri.joinPath(ext, 'dist', 'media')];
    if (this.document.uri.scheme === 'file') roots.push(vscode.Uri.file(path.dirname(this.document.uri.fsPath)));
    for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri);
    this.panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(ext, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(ext, 'media', 'icon-dark.svg'),
    };
    this.updateTitle();
    this.panel.webview.html = getWebviewHtml(this.panel.webview, ext, this.document.uri);
  }

  private updateTitle(): void {
    if (this.kind === 'panel') this.panel.title = `Preview ${path.basename(this.document.uri.path)}`;
  }

  private post(message: ToWebview): void {
    if (this.ready && !this.disposed) void this.panel.webview.postMessage(message);
  }

  // ---- rendering -------------------------------------------------------------------------

  scheduleRender(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      void this.render();
    }, RENDER_DEBOUNCE_MS);
  }

  /** The bound document, reopened if VS Code closed it (e.g. no editor shows it any more). */
  private async liveDocument(): Promise<vscode.TextDocument | undefined> {
    if (this.document.isClosed) {
      try {
        this.document = await vscode.workspace.openTextDocument(this.document.uri);
      } catch {
        return undefined;
      }
    }
    return this.document;
  }

  async render(): Promise<void> {
    if (!this.ready || this.disposed) return;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    const doc = await this.liveDocument();
    if (!doc) return;
    const result = this.manager.render(doc.getText(), {
      mermaid: this.manager.settings.mermaid,
      resolveResource: (p) => this.resolveResource(p),
    });
    this.lastRender = result;
    this.post({ type: 'render', html: result.html, headings: result.headings, hasMermaid: result.hasMermaid, docVersion: doc.version });
  }

  private resolveResource(p: string): string | undefined {
    const [pathPart] = p.split(/[?#]/);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      decoded = pathPart;
    }
    let uri: vscode.Uri | undefined;
    if (decoded.startsWith('/')) {
      const folder = vscode.workspace.getWorkspaceFolder(this.document.uri) ?? vscode.workspace.workspaceFolders?.[0];
      uri = folder ? vscode.Uri.joinPath(folder.uri, decoded) : vscode.Uri.file(decoded);
    } else if (this.document.uri.scheme === 'file') {
      uri = vscode.Uri.file(path.resolve(path.dirname(this.document.uri.fsPath), decoded));
    } else {
      const folder = vscode.workspace.workspaceFolders?.[0];
      uri = folder ? vscode.Uri.joinPath(folder.uri, decoded) : undefined;
    }
    return uri ? this.panel.webview.asWebviewUri(uri).toString() : undefined;
  }

  async sendConfig(): Promise<void> {
    if (!this.ready) return;
    this.post(await this.manager.configMessage());
  }

  // ---- sync ------------------------------------------------------------------------------

  scrollToLine(line: number): void {
    if (!this.ready) {
      this.pendingLine = line;
      return;
    }
    this.post({ type: 'scrollToLine', line });
  }

  highlightSelection(editor: vscode.TextEditor): void {
    const s = this.manager.settings;
    const sel = editor.selection;
    let message: ToWebview = { type: 'highlight', term: '', caseSensitive: s.searchCaseSensitive, blockLine: 0, occurrence: 0 };
    if (!sel.isEmpty) {
      const text = editor.document.getText(sel);
      const found = searchTermFromSelection(text, s.searchMinLength);
      if (found) {
        const start = editor.document.offsetAt(sel.start) + found.offset;
        const startPos = editor.document.positionAt(start);
        const blockLine = blockStartFor(this.blockLines, startPos.line);
        const before = editor.document.getText(new vscode.Range(blockLine, 0, startPos.line, startPos.character));
        message = {
          type: 'highlight',
          term: found.term,
          caseSensitive: s.searchCaseSensitive,
          blockLine,
          occurrence: countOccurrences(before, found.term, s.searchCaseSensitive),
        };
      }
    }
    const key = JSON.stringify(message);
    if (key === this.lastHighlightKey) return;
    this.lastHighlightKey = key;
    this.post(message);
  }

  clearHighlight(): void {
    if (!this.lastHighlightKey) return;
    this.lastHighlightKey = '';
    this.post({ type: 'highlight', term: '', caseSensitive: false, blockLine: 0, occurrence: 0 });
  }

  revealHeading(slug: string): void {
    this.post({ type: 'revealHeading', slug });
  }

  // ---- messages --------------------------------------------------------------------------

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready': {
        this.ready = true;
        this.lastHighlightKey = '';
        await this.sendConfig();
        await this.render();
        const editor = this.manager.visibleEditorFor(this.document.uri);
        if (this.pendingLine !== undefined) {
          this.post({ type: 'scrollToLine', line: this.pendingLine });
          this.pendingLine = undefined;
        } else if (editor && this.manager.settings.scrollSync) {
          this.post({ type: 'scrollToLine', line: editor.visibleRanges[0]?.start.line ?? 0 });
        }
        if (editor && this.manager.settings.searchSyncSelection) this.highlightSelection(editor);
        break;
      }
      case 'revealLine':
        if (Date.now() >= this.ignorePreviewScrollUntil) this.manager.revealSourceLine(this.document.uri, m.line);
        break;
      case 'openLink':
        await this.manager.openLink(this.document.uri, m.href);
        break;
      case 'updateSetting':
        await this.manager.updateQuickSetting(m.key, m.value);
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:huntertran.read-markdown');
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('$(check) Copied to clipboard', 2000);
        break;
      case 'showSource':
        await this.manager.showSource(this, m.line);
        break;
      case 'requestBlockSource':
        await this.sendBlockSource(m.start, m.end, m.docVersion);
        break;
      case 'editBlock':
        await this.editBlock(m.start, m.end, m.docVersion, m.text);
        break;
      case 'toggleTask':
        await this.setTaskChecked(m.line, m.checked, m.docVersion);
        break;
    }
  }

  // ---- in-preview editing ----------------------------------------------------------------

  private async sendBlockSource(start: number, end: number, docVersion: number): Promise<void> {
    if (!this.manager.settings.editEnabled) return;
    const doc = await this.liveDocument();
    const result = doc ? readBlock(doc, start, end, docVersion) : ({ error: 'failed' } as const);
    this.post({ type: 'blockSource', start, end, docVersion, ...result });
  }

  private async editBlock(start: number, end: number, docVersion: number, text: string): Promise<void> {
    if (!this.manager.settings.editEnabled) return;
    const doc = await this.liveDocument();
    const result = doc ? await applyBlockEdit(doc, start, end, docVersion, text) : ({ ok: false, error: 'failed' } as const);
    if (result.ok && doc) await this.afterEdit(doc);
    this.post({ type: 'editResult', start, end, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  private async setTaskChecked(line: number, checked: boolean, docVersion: number): Promise<void> {
    // Always reply: the webview locks its checkboxes until it hears back.
    const doc = this.manager.settings.editEnabled ? await this.liveDocument() : undefined;
    const result = doc ? await toggleTask(doc, line, checked, docVersion) : ({ ok: false, error: 'failed' } as const);
    if (result.ok && doc) await this.afterEdit(doc);
    this.post({ type: 'taskResult', line, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  private async afterEdit(doc: vscode.TextDocument): Promise<void> {
    // Render right away instead of waiting for the change listener's debounce.
    await this.render();
    if (doc.isDirty && !doc.isUntitled && (this.manager.settings.editSaveOnCommit || !this.isOpenInTextEditor())) {
      // A document not shown in any text editor would otherwise hold an unsaved edit nobody sees.
      await doc.save();
    }
  }

  /** True if a tab shows this document and so displays its unsaved state. */
  private isOpenInTextEditor(): boolean {
    const uri = this.document.uri.toString();
    // The custom editor (`readMarkdown.editor`) shows the dirty state itself, like a text editor.
    return vscode.window.tabGroups.all.some((g) =>
      g.tabs.some(
        (t) => (t.input instanceof vscode.TabInputText || t.input instanceof vscode.TabInputCustom) && t.input.uri.toString() === uri,
      ),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.emitter.fire();
    this.emitter.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}
