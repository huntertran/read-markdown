import * as path from 'node:path';
import * as vscode from 'vscode';
import { diffDocument } from '../diff/blockDiff';
import { applyBlockEdit, moveListItemEdit, readBlock, toggleTask } from '../edit/blockEdit';
import { isRenderedBlock, isRenderedListMove, isRenderedTaskLine } from '../edit/rendered';
import type { DocChanges, EditError, FromWebview, ToWebview } from '../protocol';
import type { RenderOptions, RenderResult } from '../render/markdown';
import { blockStartFor, countOccurrences, searchTermFromSelection } from '../sync/selection';
import { BaselineSync } from './baselineSync';
import { getWebviewHtml } from './html';
import { describeMessage, parseFromWebview } from './messages';
import { allowedRoots, resolveReference } from './paths';
import { pathContextFor, toUri } from './pathContext';
import type { PreviewManager } from './previewManager';

export const PREVIEW_VIEW_TYPE = 'readMarkdown.preview';
const RENDER_DEBOUNCE_MS = 250;

function eolNormalized(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** One preview webview bound to one Markdown document. */
export class PreviewPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRender: RenderResult | undefined;
  /** Document version `lastRender` was rendered from (what the webview shows, and cites in its edit requests). */
  private lastRenderVersion = -1;
  /** The git index version last rendered for change display, with the inputs it was rendered from. */
  private originalRender:
    | { original: string; mermaid: boolean; activeTasks: boolean | undefined; result: RenderResult; id: number }
    | undefined;
  /** Source of `DocChanges.baselineId`: bumped whenever `originalRender` is replaced, never reused. */
  private baselineSeq = 0;
  /** Which baseline this panel's webview holds; reset whenever the webview (re)loads. */
  private readonly baselineSync = new BaselineSync();
  /**
   * Inputs of the last render posted to the webview. An identical render would replace the DOM with the same
   * content (a save fires the text change, the file watcher and a git state change), so it is skipped.
   * Cleared whenever the webview needs a post regardless (it has no content, or an edit awaits its re-render).
   */
  private posted:
    | {
        source: string;
        original: string | undefined;
        /** Part of the message: the webview sends it back with edits, which are rejected when stale. */
        docVersion: number;
        mermaid: boolean;
        activeTasks: boolean;
        /** The webview does not re-render when this setting alone changes; it relies on the extension's post. */
        changesMode: string;
      }
    | undefined;
  /** Bumped per render so a slower, older render never overwrites a newer one. */
  private renderSeq = 0;
  private lastHighlightKey = '';
  private pendingLine: number | undefined;
  /** A render was requested while the panel was hidden; it runs once when the panel is shown again. */
  private renderPending = false;
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
      panel.webview.onDidReceiveMessage((data: unknown) => this.receive(data)),
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(({ webviewPanel }) => {
        if (!webviewPanel.visible) this.findMayBeStale = true;
        else if (this.renderPending) {
          this.renderOnShow().catch((e: unknown) => this.manager.logError('Rendering after show', e));
        }
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
    return this.lastRender?.blockLines ?? [];
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
   * reloaded page sends `ready` and the handler below re-sends config and content; its scroll line comes from
   * `WebviewState` (kept by VS Code across reloads). An open block editor is lost. Nothing is posted until then.
   */
  reloadWebview(): void {
    if (this.disposed) return;
    this.ready = false;
    this.baselineSync.forget();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
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

  private post(message: ToWebview): void {
    if (this.ready && !this.disposed) void this.panel.webview.postMessage(message);
  }

  // ---- rendering -------------------------------------------------------------------------

  scheduleRender(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    // The panel keeps its context while hidden, so skip the pipeline and catch up once when it is shown.
    if (!this.panel.visible) {
      this.renderPending = true;
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render().catch((e: unknown) => this.manager.logError('Rendering', e));
    }, RENDER_DEBOUNCE_MS);
  }

  /** Renders now, or, while the panel is hidden, defers to the next time it is shown. */
  async render(): Promise<void> {
    if (!this.ready || this.disposed) return;
    if (!this.panel.visible) {
      if (this.renderTimer) clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.renderPending = true;
      return;
    }
    await this.renderNow();
  }

  /** The deferred render, then the search highlight, whose block line may have changed meanwhile. */
  private async renderOnShow(): Promise<void> {
    await this.render();
    const editor = this.manager.visibleEditorFor(this.document.uri);
    if (this.renderPending || !editor || !this.manager.settings.searchSyncSelection) return;
    this.lastHighlightKey = '';
    this.highlightSelection(editor);
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

  private async renderNow(): Promise<void> {
    if (!this.ready || this.disposed) return;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.renderPending = false;
    const seq = ++this.renderSeq;
    const doc = await this.liveDocument();
    // Disposed meanwhile: asking for the baseline now would re-create the entry the manager just released.
    if (!doc || this.disposed) return;
    // Text and version are read together, before any further await, so the posted version matches the text.
    const source = doc.getText();
    const docVersion = doc.version;
    const { mermaid, agentProgress: activeTasks, changesMode } = this.manager.settings;
    // Fetched before rendering so an identical render is skipped without the Markdown and diff work.
    const original = changesMode === 'off' ? undefined : await this.manager.baseline.getOriginal(this.document.uri);
    if (seq !== this.renderSeq || this.disposed) return;
    const last = this.posted;
    if (
      last &&
      last.source === source &&
      last.original === original &&
      last.docVersion === docVersion &&
      last.mermaid === mermaid &&
      last.activeTasks === activeTasks &&
      last.changesMode === changesMode
    ) {
      return;
    }
    const options: RenderOptions = { mermaid, activeTasks, resolveResource: (p) => this.resolveResource(p) };
    const result = this.manager.render(source, options);
    const found = this.changesFor(source, original, result, options);
    // The baseline travels only when the webview does not hold it (claimed here, in the same turn as the post).
    const sendBaseline = this.baselineSync.claim(found?.baselineId);
    const changes: DocChanges | undefined = found && (sendBaseline ? found : { baselineId: found.baselineId, ops: found.ops });
    this.lastRender = result;
    this.lastRenderVersion = docVersion;
    this.posted = { source, original, docVersion, mermaid, activeTasks, changesMode };
    this.post({
      type: 'render',
      html: result.html,
      headings: result.headings,
      hasMermaid: result.hasMermaid,
      docVersion,
      changes,
    });
  }

  /** Changes of `source` against the file's git index version `original` (undefined: none, or not shown). */
  private changesFor(
    source: string,
    original: string | undefined,
    current: RenderResult,
    options: RenderOptions,
  ): (DocChanges & { originalHtml: string }) | undefined {
    if (original === undefined || eolNormalized(original) === eolNormalized(source)) return undefined;
    // Re-render the original when it or a setting that changes rendering changed.
    let cached = this.originalRender;
    if (
      !cached ||
      cached.original !== original ||
      cached.mermaid !== options.mermaid ||
      cached.activeTasks !== options.activeTasks
    ) {
      cached = {
        original,
        mermaid: options.mermaid,
        activeTasks: options.activeTasks,
        result: this.manager.render(original, options),
        id: ++this.baselineSeq,
      };
      this.originalRender = cached;
    }
    const ops = diffDocument(cached.result.topBlocks, current.topBlocks);
    return ops?.length ? { baselineId: cached.id, originalHtml: cached.result.html, ops } : undefined;
  }

  /** Asks the webview to switch between inline changes and gutter bars. */
  toggleChanges(): void {
    this.post({ type: 'toggleChanges' });
  }

  private resolveResource(p: string): string | undefined {
    // Relative to the first workspace folder for documents that are not local files: how images always resolved.
    const ref = resolveReference(p, pathContextFor(this.document.uri, 'workspace'));
    // A target outside `localResourceRoots` still gets a URI; the webview just fails to load it.
    return ref.kind === 'local' ? this.panel.webview.asWebviewUri(toUri(ref)).toString() : undefined;
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
    // `blockLines` is stale while a render is deferred; `renderOnShow` sends the highlight after the fresh render.
    if (this.renderPending) return;
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

  /** Opens the block starting at source `line` in the in-preview editor. */
  startEdit(line: number): void {
    this.post({ type: 'startEdit', line });
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
      case 'ready': {
        this.ready = true;
        this.lastHighlightKey = '';
        // A (re)loaded webview has no content, whatever was posted to its predecessor.
        this.posted = undefined;
        this.baselineSync.forget();
        await this.sendConfig();
        // Render even if hidden (e.g. restored in a background tab): this is the webview's first content, and it
        // keeps `lastRender` fresh for the scroll/highlight messages below.
        await this.renderNow();
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
      case 'needBaseline':
        // The webview cited a baseline it does not hold (safety net; it asks once per id). Send the render again,
        // this time with the HTML, even though its inputs are unchanged.
        if (this.baselineSync.missing(m.id)) {
          this.posted = undefined;
          await this.render();
        }
        break;
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
      case 'moveListItem':
        await this.moveListItem(m.starts, m.end, m.from, m.to, m.docVersion);
        break;
    }
  }

  // ---- in-preview editing ----------------------------------------------------------------

  /**
   * Why an edit request is refused before touching the document, or undefined if `isRendered` accepts the
   * ranges of the render the webview is showing. Edit requests carry ranges from `data-line*` attributes, which
   * raw HTML in the document could forge, so a range is only honoured if the renderer produced it for exactly
   * the document version the request cites: no render of that version (the preview is behind or ahead of the
   * document) = `stale`, like the version check in `edit/blockEdit.ts`; a range the render never produced =
   * `invalid`.
   */
  private checkRendered(doc: vscode.TextDocument, docVersion: number, isRendered: (render: RenderResult) => boolean): EditError | undefined {
    const render = this.lastRender;
    if (!render || this.lastRenderVersion !== docVersion || doc.version !== docVersion) return 'stale';
    return isRendered(render) ? undefined : 'invalid';
  }

  private async sendBlockSource(start: number, end: number, docVersion: number): Promise<void> {
    // Always reply: the webview waits for the source before opening the editor.
    const doc = this.manager.settings.editEnabled ? await this.liveDocument() : undefined;
    const error = doc && this.checkRendered(doc, docVersion, (r) => isRenderedBlock(r.topBlocks, start, end));
    const result = !doc ? ({ error: 'failed' } as const) : error ? { error } : readBlock(doc, start, end, docVersion);
    this.post({ type: 'blockSource', start, end, docVersion, ...result });
  }

  private async editBlock(start: number, end: number, docVersion: number, text: string): Promise<void> {
    const doc = this.manager.settings.editEnabled ? await this.liveDocument() : undefined;
    const error = doc && this.checkRendered(doc, docVersion, (r) => isRenderedBlock(r.topBlocks, start, end));
    const result = !doc ? ({ ok: false, error: 'failed' } as const) : error ? ({ ok: false, error } as const) : await applyBlockEdit(doc, start, end, docVersion, text);
    if (result.ok && doc) await this.afterEdit(doc);
    this.post({ type: 'editResult', start, end, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  private async setTaskChecked(line: number, checked: boolean, docVersion: number): Promise<void> {
    // Always reply: the webview locks its checkboxes until it hears back.
    const doc = this.manager.settings.editEnabled ? await this.liveDocument() : undefined;
    const error = doc && this.checkRendered(doc, docVersion, (r) => isRenderedTaskLine(r.taskLines, line));
    const result = !doc ? ({ ok: false, error: 'failed' } as const) : error ? ({ ok: false, error } as const) : await toggleTask(doc, line, checked, docVersion);
    if (result.ok && doc) await this.afterEdit(doc);
    this.post({ type: 'taskResult', line, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  private async moveListItem(starts: number[], end: number, from: number, to: number, docVersion: number): Promise<void> {
    // Always reply: the webview has already reordered the list and puts it back on failure.
    const doc = this.manager.settings.editEnabled ? await this.liveDocument() : undefined;
    const error = doc && this.checkRendered(doc, docVersion, (r) => isRenderedListMove(r.lists, starts, end));
    const result = !doc ? ({ ok: false, error: 'failed' } as const) : error ? ({ ok: false, error } as const) : await moveListItemEdit(doc, starts, end, from, to, docVersion);
    if (result.ok && doc) await this.afterEdit(doc);
    this.post(result.ok ? { type: 'moveResult', ok: true, line: result.line } : { type: 'moveResult', ok: false, error: result.error });
  }

  private async afterEdit(doc: vscode.TextDocument): Promise<void> {
    // Render right away instead of waiting for the change listener's debounce. Always post: the webview reorders
    // or toggles its DOM optimistically and relies on this render (before the result message) to settle it,
    // even if the edit left the text unchanged.
    this.posted = undefined;
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
    this.disposables.forEach((d) => {
      d.dispose();
    });
    this.panel.dispose();
  }
}
