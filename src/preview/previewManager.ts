import * as path from 'node:path';
import * as vscode from 'vscode';
import { CustomCssProvider } from '../config/customCss';
import { type Settings, getSettings, toUiConfig, updateSetting, validateQuickSetting } from '../config/settings';
import { buildCssVariables } from '../config/styles';
import type { ToWebview, WebviewState } from '../protocol';
import { type RenderOptions, type RenderResult, createMarkdownRenderer } from '../render/markdown';
import { GitBaseline } from '../scm/gitBaseline';
import { isRestorableScheme, uriScheme } from './messages';
import { LinkOpener, outsideTargetPrompt } from './linkOpener';
import { pathContextFor, toUri } from './pathContext';
import { PREVIEW_VIEW_TYPE, PreviewPanel } from './previewPanel';

const SCROLL_ECHO_MS = 300;

export function isMarkdownDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'markdown' && (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled' || doc.uri.scheme === 'vscode-remote');
}

export class PreviewManager implements vscode.Disposable {
  private readonly panels = new Set<PreviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output = vscode.window.createOutputChannel('Read Markdown');
  private readonly renderer = createMarkdownRenderer();
  private readonly customCss = new CustomCssProvider();
  /** Git index versions, for showing changes in the preview. */
  readonly baseline = new GitBaseline();
  private readonly ignoreEditorScrollUntil = new WeakMap<vscode.TextEditor, number>();
  /**
   * First visible line of each editor at its last visible-range event. Edits that replace several
   * lines (e.g. moving a list item from the preview) fire the event although the editor did not
   * scroll; without this check the preview would jump to the editor's top line.
   */
  private readonly editorTopLine = new WeakMap<vscode.TextEditor, number>();
  private readonly autoOpened = new Set<string>();
  private readonly links = new LinkOpener({
    pathContext: (from) => pathContextFor(from),
    toUri,
    confirm: async (target) => {
      const { message, detail, accept } = outsideTargetPrompt(target);
      return (await vscode.window.showWarningMessage(message, { modal: true, detail }, accept)) === accept;
    },
    stat: async (target) => {
      await vscode.workspace.fs.stat(target);
    },
    warn: (message) => {
      void vscode.window.showWarningMessage(message);
    },
    openPreview: (target) => this.open(target, this.active?.panel.viewColumn ?? vscode.ViewColumn.Active, false),
    openFile: async (target) => {
      await vscode.commands.executeCommand('vscode.open', target);
    },
    openExternal: async (href) => {
      await vscode.env.openExternal(vscode.Uri.parse(href, true));
    },
    revealFragment: (from, fragment) => {
      for (const p of this.panelsFor(from)) p.revealHeading(fragment);
    },
  });
  private active: PreviewPanel | undefined;
  settings: Settings = getSettings();

  constructor(readonly extensionUri: vscode.Uri) {
    this.customCss.configure(this.settings.customCssFiles, this.settings.customCssInline);
    this.seedTopLines(vscode.window.visibleTextEditors);
    this.disposables.push(
      this.output,
      this.customCss,
      this.customCss.onDidChange(() => this.broadcastConfig()),
      this.baseline,
      this.baseline.onDidChange((uri) => {
        if (this.settings.changesMode === 'off') return;
        for (const p of uri ? this.panelsFor(uri) : this.panels) p.scheduleRender();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) return;
        for (const p of this.panelsFor(e.document.uri)) p.scheduleRender();
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.autoOpened.delete(doc.uri.toString())),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!this.settings.searchSyncSelection) return;
        for (const p of this.panelsFor(e.textEditor.document.uri)) p.highlightSelection(e.textEditor);
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        const line = e.visibleRanges[0]?.start.line;
        if (line === undefined) return;
        const previous = this.editorTopLine.get(e.textEditor);
        this.editorTopLine.set(e.textEditor, line);
        if (!this.settings.scrollSync || line === previous) return;
        if (Date.now() < (this.ignoreEditorScrollUntil.get(e.textEditor) ?? 0)) return;
        for (const p of this.panelsFor(e.textEditor.document.uri)) {
          p.ignorePreviewScrollUntil = Date.now() + SCROLL_ECHO_MS;
          p.scrollToLine(line);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => this.seedTopLines(editors)),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.maybeAutoOpen(editor)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('readMarkdown')) this.onConfigChanged();
      }),
    );
  }

  /** Writes a line to the "Read Markdown" output channel. Never pass document or message contents. */
  log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  /** Logs a rejected background task: the error message only, never the document. */
  logError(task: string, error: unknown): void {
    this.log(`${task} failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ---- panel registry --------------------------------------------------------------------

  private panelsFor(uri: vscode.Uri): PreviewPanel[] {
    return [...this.panels].filter((p) => p.matches(uri));
  }

  private track(panel: PreviewPanel): PreviewPanel {
    this.panels.add(panel);
    panel.onDidDispose(() => {
      this.panels.delete(panel);
      // No other panel (side preview / custom editor) shows the document: stop refreshing its baseline.
      if (this.panelsFor(panel.uri).length === 0) this.baseline.release(panel.uri);
      if (this.active === panel) this.active = undefined;
    });
    if (panel.panel.active) this.active = panel;
    return panel;
  }

  setActive(panel: PreviewPanel): void {
    this.active = panel;
  }

  get activePanel(): PreviewPanel | undefined {
    return this.active && this.active.panel.active ? this.active : undefined;
  }

  get lastActivePanel(): PreviewPanel | undefined {
    return this.active;
  }

  async open(uri: vscode.Uri, column: vscode.ViewColumn, preserveFocus: boolean): Promise<PreviewPanel> {
    const existing = this.panelsFor(uri).find((p) => p.kind === 'panel');
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn ?? column, preserveFocus);
      return existing;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const panel = vscode.window.createWebviewPanel(
      PREVIEW_VIEW_TYPE,
      `Preview ${path.basename(uri.path)}`,
      { viewColumn: column, preserveFocus },
      { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true },
    );
    const preview = this.track(new PreviewPanel(panel, document, this, 'panel'));
    if (!preserveFocus) this.active = preview;
    return preview;
  }

  async restore(panel: vscode.WebviewPanel, state: WebviewState | undefined): Promise<void> {
    // The saved state is untrusted: only open the URI schemes the extension itself previews.
    if (!state?.uri || !isRestorableScheme(uriScheme(state.uri))) {
      panel.dispose();
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(state.uri));
      this.track(new PreviewPanel(panel, document, this, 'panel'));
    } catch {
      panel.dispose();
    }
  }

  attachCustomEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    this.track(new PreviewPanel(panel, document, this, 'editor'));
  }

  // ---- rendering & config ----------------------------------------------------------------

  render(source: string, options: RenderOptions): RenderResult {
    return this.renderer(source, options);
  }

  async configMessage(): Promise<ToWebview> {
    return {
      type: 'config',
      css: buildCssVariables(this.settings),
      customCss: await this.customCss.get(),
      ui: toUiConfig(this.settings),
    };
  }

  private broadcastConfig(): void {
    for (const p of this.panels) p.sendConfig().catch((e: unknown) => this.logError('Sending the config', e));
  }

  private onConfigChanged(): void {
    const prev = this.settings;
    this.settings = getSettings();
    this.customCss.configure(this.settings.customCssFiles, this.settings.customCssInline);
    // The CSP is part of the page, so a change needs a new page. It also covers a workspace turning trusted
    // (the effective value changes). The reload makes each panel send `ready`, which re-sends config and content.
    if (prev.allowRemoteContent !== this.settings.allowRemoteContent) for (const p of this.panels) p.reloadWebview();
    this.broadcastConfig();
    if (
      prev.mermaid !== this.settings.mermaid ||
      prev.changesMode !== this.settings.changesMode ||
      prev.agentProgress !== this.settings.agentProgress
    ) {
      for (const p of this.panels) p.render().catch((e: unknown) => this.logError('Rendering', e));
    }
    if (prev.searchSyncSelection && !this.settings.searchSyncSelection) for (const p of this.panels) p.clearHighlight();
  }

  async updateQuickSetting(key: string, value: unknown): Promise<void> {
    const valid = validateQuickSetting(key, value);
    if (valid === undefined) return;
    await updateSetting(key, valid);
  }

  async toggleNav(): Promise<void> {
    await updateSetting('nav.show', !this.settings.navShow);
  }

  /** Switches the focused preview between inline track changes and gutter bars. */
  toggleChanges(): void {
    (this.activePanel ?? this.lastActivePanel)?.toggleChanges();
  }

  // ---- source editor interaction ---------------------------------------------------------

  visibleEditorFor(uri: vscode.Uri): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
  }

  /** Records where newly shown editors start, so their first visible-range event is compared too. */
  private seedTopLines(editors: readonly vscode.TextEditor[]): void {
    for (const editor of editors) {
      const line = editor.visibleRanges[0]?.start.line;
      if (line !== undefined && !this.editorTopLine.has(editor)) this.editorTopLine.set(editor, line);
    }
  }

  revealSourceLine(uri: vscode.Uri, line: number): void {
    if (!this.settings.scrollSync) return;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== uri.toString()) continue;
      const l = Math.max(0, Math.min(editor.document.lineCount - 1, Math.floor(line)));
      this.ignoreEditorScrollUntil.set(editor, Date.now() + SCROLL_ECHO_MS);
      editor.revealRange(new vscode.Range(l, 0, l, 0), vscode.TextEditorRevealType.AtTop);
    }
  }

  async showSource(panel: PreviewPanel, line?: number): Promise<void> {
    const visible = this.visibleEditorFor(panel.uri);
    const editor = await vscode.window.showTextDocument(panel.uri, {
      viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: false,
    });
    if (line !== undefined) {
      const pos = new vscode.Position(Math.max(0, line), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  async openLink(from: vscode.Uri, href: string): Promise<void> {
    await this.links.open(from, href);
  }

  // ---- auto open -------------------------------------------------------------------------

  maybeAutoOpen(editor: vscode.TextEditor | undefined): void {
    const mode = this.settings.autoOpen;
    if (mode === 'off' || !editor || !isMarkdownDocument(editor.document)) return;
    if (editor.viewColumn === undefined) return;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab && tab.input instanceof vscode.TabInputTextDiff) return;
    const key = editor.document.uri.toString();
    if (this.autoOpened.has(key) || this.panelsFor(editor.document.uri).length > 0) return;
    this.autoOpened.add(key);
    const opening =
      mode === 'beside'
        ? this.open(editor.document.uri, vscode.ViewColumn.Beside, true)
        : this.open(editor.document.uri, editor.viewColumn, false);
    opening.catch((e: unknown) => this.logError('Opening the preview automatically', e));
  }

  dispose(): void {
    for (const p of [...this.panels]) p.dispose();
    this.disposables.forEach((d) => {
      d.dispose();
    });
  }
}
