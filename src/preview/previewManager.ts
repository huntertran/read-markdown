import * as path from 'node:path';
import * as vscode from 'vscode';
import { CustomCssProvider } from '../config/customCss';
import { type Settings, getSettings, toUiConfig, updateSetting, validateQuickSetting } from '../config/settings';
import { buildCssVariables } from '../config/styles';
import type { ToWebview, WebviewState } from '../protocol';
import { type RenderOptions, type RenderResult, createMarkdownRenderer } from '../render/markdown';
import { GitBaseline } from '../scm/gitBaseline';
import { PREVIEW_VIEW_TYPE, PreviewPanel } from './previewPanel';

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mkdn)$/i;
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto']);
const SCROLL_ECHO_MS = 300;

export function isMarkdownDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'markdown' && (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled' || doc.uri.scheme === 'vscode-remote');
}

export class PreviewManager implements vscode.Disposable {
  private readonly panels = new Set<PreviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly renderer = createMarkdownRenderer();
  private readonly customCss = new CustomCssProvider();
  /** Git index versions, for showing changes in the preview. */
  readonly baseline = new GitBaseline();
  private readonly ignoreEditorScrollUntil = new WeakMap<vscode.TextEditor, number>();
  private readonly autoOpened = new Set<string>();
  private active: PreviewPanel | undefined;
  settings: Settings = getSettings();

  constructor(readonly extensionUri: vscode.Uri) {
    this.customCss.configure(this.settings.customCssFiles, this.settings.customCssInline);
    this.disposables.push(
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
        if (!this.settings.scrollSync) return;
        if (Date.now() < (this.ignoreEditorScrollUntil.get(e.textEditor) ?? 0)) return;
        const line = e.visibleRanges[0]?.start.line;
        if (line === undefined) return;
        for (const p of this.panelsFor(e.textEditor.document.uri)) {
          p.ignorePreviewScrollUntil = Date.now() + SCROLL_ECHO_MS;
          p.scrollToLine(line);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.maybeAutoOpen(editor)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('readMarkdown')) this.onConfigChanged();
      }),
    );
  }

  // ---- panel registry --------------------------------------------------------------------

  private panelsFor(uri: vscode.Uri): PreviewPanel[] {
    return [...this.panels].filter((p) => p.matches(uri));
  }

  private track(panel: PreviewPanel): PreviewPanel {
    this.panels.add(panel);
    panel.onDidDispose(() => {
      this.panels.delete(panel);
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
    if (!state?.uri) {
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
    for (const p of this.panels) void p.sendConfig();
  }

  private onConfigChanged(): void {
    const prev = this.settings;
    this.settings = getSettings();
    this.customCss.configure(this.settings.customCssFiles, this.settings.customCssInline);
    this.broadcastConfig();
    if (prev.mermaid !== this.settings.mermaid || prev.changesMode !== this.settings.changesMode) {
      for (const p of this.panels) void p.render();
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
    if (!href) return;
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(href);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase();
      if (EXTERNAL_SCHEMES.has(scheme)) await vscode.env.openExternal(vscode.Uri.parse(href, true));
      else if (scheme === 'file') await this.openLocal(vscode.Uri.parse(href, true));
      // Other schemes (command:, vscode:, javascript:...) are ignored on purpose.
      return;
    }
    const hashIndex = href.indexOf('#');
    const rawPath = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
    const fragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : '';
    if (!rawPath) {
      for (const p of this.panelsFor(from)) p.revealHeading(fragment);
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath.split('?')[0]);
    } catch {
      decoded = rawPath;
    }
    let target: vscode.Uri;
    if (decoded.startsWith('/')) {
      const folder = vscode.workspace.getWorkspaceFolder(from) ?? vscode.workspace.workspaceFolders?.[0];
      target = folder ? vscode.Uri.joinPath(folder.uri, decoded) : vscode.Uri.file(decoded);
    } else if (from.scheme === 'file') {
      target = vscode.Uri.file(path.resolve(path.dirname(from.fsPath), decoded));
    } else {
      target = vscode.Uri.joinPath(from, '..', decoded);
    }
    await this.openLocal(target, fragment);
  }

  private async openLocal(target: vscode.Uri, fragment = ''): Promise<void> {
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      void vscode.window.showWarningMessage(`Read Markdown: file not found: ${target.fsPath || target.toString()}`);
      return;
    }
    if (MARKDOWN_EXT.test(target.path)) {
      const column = this.active?.panel.viewColumn ?? vscode.ViewColumn.Active;
      const preview = await this.open(target, column, false);
      if (fragment) preview.revealHeading(decodeURIComponent(fragment));
      return;
    }
    await vscode.commands.executeCommand('vscode.open', target);
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
    if (mode === 'beside') void this.open(editor.document.uri, vscode.ViewColumn.Beside, true);
    else void this.open(editor.document.uri, editor.viewColumn, false);
  }

  dispose(): void {
    for (const p of [...this.panels]) p.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
