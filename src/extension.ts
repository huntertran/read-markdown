import * as vscode from 'vscode';
import type { BlockMenuContext, WebviewState } from './protocol';
import { PreviewManager } from './preview/previewManager';
import { PREVIEW_VIEW_TYPE } from './preview/previewPanel';

export const CUSTOM_EDITOR_VIEW_TYPE = 'readMarkdown.editor';

let manager: PreviewManager | undefined;

function resolveTarget(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri instanceof vscode.Uri) return uri;
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'markdown') return editor.document.uri;
  return manager?.lastActivePanel?.uri;
}

function blockLine(ctx: unknown): number | undefined {
  const line = (ctx as BlockMenuContext | undefined)?.rmLine;
  return typeof line === 'number' && Number.isInteger(line) && line >= 0 ? line : undefined;
}

export function activate(context: vscode.ExtensionContext): { manager: PreviewManager } {
  const m = new PreviewManager(context.extensionUri);
  manager = m;
  context.subscriptions.push(m);

  context.subscriptions.push(
    vscode.commands.registerCommand('readMarkdown.openPreview', async (uri?: vscode.Uri) => {
      const target = resolveTarget(uri);
      if (!target) return void vscode.window.showInformationMessage('Read Markdown: open a Markdown file first.');
      await m.open(target, vscode.ViewColumn.Active, false);
    }),
    vscode.commands.registerCommand('readMarkdown.openPreviewToSide', async (uri?: vscode.Uri) => {
      const target = resolveTarget(uri);
      if (!target) return void vscode.window.showInformationMessage('Read Markdown: open a Markdown file first.');
      await m.open(target, vscode.ViewColumn.Beside, true);
    }),
    vscode.commands.registerCommand('readMarkdown.toggleNav', () => m.toggleNav()),
    vscode.commands.registerCommand('readMarkdown.toggleChanges', () => m.toggleChanges()),
    // From the preview's context menu, `ctx` holds the right-clicked block's line; from the
    // title bar or palette it is absent (or a URI), and the source opens at its current position.
    vscode.commands.registerCommand('readMarkdown.showSource', async (ctx?: BlockMenuContext) => {
      const panel = m.activePanel ?? m.lastActivePanel;
      if (panel) await m.showSource(panel, blockLine(ctx));
    }),
    vscode.commands.registerCommand('readMarkdown.editBlock', (ctx?: BlockMenuContext) => {
      const panel = m.activePanel ?? m.lastActivePanel;
      const line = blockLine(ctx);
      if (panel && line !== undefined) panel.startEdit(line);
    }),

    vscode.window.registerWebviewPanelSerializer(PREVIEW_VIEW_TYPE, {
      deserializeWebviewPanel: (panel: vscode.WebviewPanel, state: WebviewState | undefined) => m.restore(panel, state),
    }),

    vscode.window.registerCustomEditorProvider(
      CUSTOM_EDITOR_VIEW_TYPE,
      {
        resolveCustomTextEditor: (document, panel) => m.attachCustomEditor(document, panel),
      },
      { webviewOptions: { enableFindWidget: true, retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true },
    ),
  );

  m.maybeAutoOpen(vscode.window.activeTextEditor);
  return { manager: m };
}

export function deactivate(): void {
  manager = undefined;
}
