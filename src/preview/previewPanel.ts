import * as path from 'node:path';
import * as vscode from 'vscode';
import { assertNever } from '../assertNever';
import { applyBlockEdit, moveListItemEdit, readBlock, toggleTask } from '../edit/blockEdit';
import { EditController } from '../edit/editController';
import type { FromWebview } from '../protocol';
import { blockStartFor, countOccurrences, searchTermFromSelection } from '../sync/selection';
import { EchoWindow } from '../sync/scrollEcho';
import { getWebviewHtml } from './html';
import { describeMessage, parseFromWebview } from './messages';
import { allowedRoots, resolveReference } from './paths';
import { pathContextFor, toUri } from './pathContext';
import type { PreviewManager } from './previewManager';
import { type HighlightMessage, RenderCoordinator } from './renderCoordinator';

export const PREVIEW_VIEW_TYPE = 'readMarkdown.preview';

/** One preview webview bound to one Markdown document. */
export class PreviewPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  /** Set while hidden; VS Code may wrongly re-show a closed find widget when the panel returns. */
  private findMayBeStale = false;
  /** Started when the host scrolls the webview: its scroll messages are ignored meanwhile (no feedback loop). */
  readonly previewEcho = new EchoWindow();

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.emitter.event;

  /** The render pipeline and the messages that depend on the webview's state; VS Code is reached through these callbacks. */
  private readonly renderer = new RenderCoordinator({
    isVisible: () => this.panel.visible,
    liveDocument: () => this.liveDocument(),
    settings: () => this.manager.settings,
    getOriginal: () => this.manager.baseline.getOriginal(this.document.uri),
    render: (source, options) => this.manager.render(source, options),
    resolveResource: (p) => this.resolveResource(p),
    postMessage: (message) => void this.panel.webview.postMessage(message),
    configMessage: () => this.manager.configMessage(),
    sourceEditor: () => {
      const editor = this.manager.visibleEditorFor(this.document.uri);
      return editor && { topLine: () => editor.visibleRanges[0]?.start.line ?? 0, highlight: () => this.highlightFor(editor) };
    },
    logError: (task, error) => this.manager.logError(task, error),
  });

  /** Handles the in-preview edit requests; it reads the panel's state only through these callbacks. */
  private readonly edits = new EditController(
    {
      settings: () => this.manager.settings,
      liveDocument: () => this.liveDocument(),
      lastRender: () => this.renderer.lastRender(),
      post: (message) => this.renderer.post(message),
      renderAfterEdit: () => this.renderer.renderAfterEdit(),
      isShownInEditor: () => {
        const uri = this.document.uri.toString();
        // The custom editor (`readMarkdown.editor`) shows the dirty state itself, like a text editor.
        return vscode.window.tabGroups.all.some((g) =>
          g.tabs.some(
            (t) => (t.input instanceof vscode.TabInputText || t.input instanceof vscode.TabInputCustom) && t.input.uri.toString() === uri,
          ),
        );
      },
      save: async (doc) => {
        // `save` reports most failures by resolving to false, not by rejecting.
        if (!(await doc.save())) throw new Error('The document could not be saved');
      },
      logError: (task, error) => this.manager.logError(task, error),
    },
    { readBlock, applyBlockEdit, toggleTask, moveListItemEdit },
  );

  constructor(
    readonly panel: vscode.WebviewPanel,
    private document: vscode.TextDocument,
    private readonly manager: PreviewManager,
    readonly kind: 'panel' | 'editor',
  ) {
    this.configureWebview();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((data: unknown) => this.receive(data)),
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(({ webviewPanel }) => {
        if (!webviewPanel.visible) this.findMayBeStale = true;
        else this.renderer.onShown();
        if (webviewPanel.active) {
          manager.setActive(this);
          if (this.findMayBeStale) {
            this.findMayBeStale = false;
            // VS Code bug: closing the webview find widget from inside it (× button, possibly Escape) does not reset the
            // `webviewFindWidgetVisible` context key, so the widget is re-shown when the hidden
            // webview is restored. Close it again; the command only acts on the active webview.
            // https://github.com/microsoft/vscode/issues/307943
            // TODO: remove this workaround (and `findMayBeStale`) once `engines.vscode` >= the fixed version.
            vscode.commands
              .executeCommand('editor.action.webvieweditor.hideFind')
              .then(undefined, (e: unknown) => this.manager.logError('Closing the find widget', e));
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
    return this.renderer.blockLines;
  }

  matches(uri: vscode.Uri): boolean {
    return this.document.uri.toString() === uri.toString();
  }

  private configureWebview(): void {
    const ext = this.manager.extensionUri;
    const roots = [vscode.Uri.joinPath(ext, 'media'), vscode.Uri.joinPath(ext, 'dist', 'media')];
    roots.push(...allowedRoots(pathContextFor(this.document.uri)).map(toUri));
    this.panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(ext, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(ext, 'media', 'icon-dark.svg'),
    };
    this.updateTitle();
    this.panel.webview.html = getWebviewHtml(
      this.panel.webview,
      ext,
      this.document.uri,
      this.manager.settings.allowRemoteContent,
    );
  }

  /**
   * Rebuilds the webview HTML (new nonce, new CSP), which reloads the page: the CSP is fixed at load time. The
   * reloaded page sends `ready` and `RenderCoordinator.onReady` re-sends config and content; its scroll line comes from
   * `WebviewState` (kept by VS Code across reloads). An open block editor is lost. Nothing is posted until then.
   */
  reloadWebview(): void {
    if (this.disposed) return;
    this.renderer.reload();
    this.panel.webview.html = getWebviewHtml(
      this.panel.webview,
      this.manager.extensionUri,
      this.document.uri,
      this.manager.settings.allowRemoteContent,
    );
  }

  private updateTitle(): void {
    if (this.kind === 'panel') this.panel.title = `Preview ${path.basename(this.document.uri.path)}`;
  }

  // ---- rendering -------------------------------------------------------------------------

  /** Renders after the debounce, or, while the panel is hidden, once it is shown again. */
  scheduleRender(): void {
    this.renderer.scheduleRender();
  }

  /** Renders now, or, while the panel is hidden, defers to the next time it is shown. */
  render(): Promise<void> {
    return this.renderer.render();
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

  /** Asks the webview to switch between inline changes and gutter bars. */
  toggleChanges(): void {
    this.renderer.post({ type: 'toggleChanges' });
  }

  private resolveResource(p: string): string | undefined {
    // Relative to the first workspace folder for documents that are not local files: how images always resolved.
    const ref = resolveReference(p, pathContextFor(this.document.uri, 'workspace'));
    // A target outside `localResourceRoots` still gets a URI; the webview just fails to load it.
    return ref.kind === 'local' ? this.panel.webview.asWebviewUri(toUri(ref)).toString() : undefined;
  }

  sendConfig(): Promise<void> {
    return this.renderer.sendConfig();
  }

  // ---- sync ------------------------------------------------------------------------------

  scrollToLine(line: number): void {
    this.renderer.scrollToLine(line);
  }

  /** Highlights the editor's selection in the preview (skipped while a render is deferred, deduped). */
  highlightSelection(editor: vscode.TextEditor): void {
    this.renderer.highlight(() => this.highlightFor(editor));
  }

  /** The highlight message for the editor's selection, located against the last render's block lines. */
  private highlightFor(editor: vscode.TextEditor): HighlightMessage {
    const s = this.manager.settings;
    const sel = editor.selection;
    let message: HighlightMessage = { type: 'highlight', term: '', caseSensitive: s.searchCaseSensitive, blockLine: 0, occurrence: 0 };
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
    return message;
  }

  clearHighlight(): void {
    this.renderer.clearHighlight();
  }

  revealHeading(slug: string): void {
    this.renderer.post({ type: 'revealHeading', slug });
  }

  /** Opens the block starting at source `line` in the in-preview editor. */
  startEdit(line: number): void {
    this.renderer.post({ type: 'startEdit', line });
  }

  // ---- messages --------------------------------------------------------------------------

  /** Validates a message from the (untrusted) webview and handles it; failures are logged, never thrown. */
  private async receive(data: unknown): Promise<void> {
    const m = parseFromWebview(data);
    if (!m) {
      this.manager.log(`Ignored invalid message from the webview (${describeMessage(data)}).`);
      return;
    }
    try {
      await this.onMessage(m);
    } catch (e) {
      // Log the error message only, never the webview's payload.
      this.manager.log(`Handling "${m.type}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready':
        // Config, then the render (even if hidden), then the scroll line and the highlight.
        await this.renderer.onReady();
        break;
      case 'needBaseline':
        await this.renderer.onNeedBaseline(m.id);
        break;
      case 'revealLine':
        if (!this.previewEcho.active) this.manager.revealSourceLine(this.document.uri, m.line);
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
        await this.edits.sendBlockSource(m.start, m.end, m.docVersion);
        break;
      case 'editBlock':
        await this.edits.editBlock(m.start, m.end, m.docVersion, m.text);
        break;
      case 'toggleTask':
        await this.edits.setTaskChecked(m.line, m.checked, m.docVersion);
        break;
      case 'moveListItem':
        await this.edits.moveListItem(m.starts, m.end, m.from, m.to, m.docVersion);
        break;
      default:
        assertNever(m);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.dispose();
    this.emitter.fire();
    this.emitter.dispose();
    this.disposables.forEach((d) => {
      d.dispose();
    });
    this.panel.dispose();
  }
}
