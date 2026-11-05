import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'huntertran.read-markdown';

function fixture(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'fixture workspace must be open');
  return vscode.Uri.file(path.join(folder.uri.fsPath, name));
}

function previewTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('readMarkdown.preview'));
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Read Markdown extension', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'extension should be installed');
    await ext.activate();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const c of ['readMarkdown.openPreview', 'readMarkdown.openPreviewToSide', 'readMarkdown.toggleNav', 'readMarkdown.showSource']) {
      assert.ok(commands.includes(c), `missing command ${c}`);
    }
  });

  it('opens a preview to the side for the active markdown file', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('long-ai-doc.md'));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('readMarkdown.openPreviewToSide');
    await waitFor(() => previewTabs().length === 1);
    assert.equal(previewTabs()[0].label, 'Preview long-ai-doc.md');
  });

  it('reuses the existing preview for the same document', async () => {
    const uri = fixture('long-ai-doc.md');
    await vscode.commands.executeCommand('readMarkdown.openPreview', uri);
    await vscode.commands.executeCommand('readMarkdown.openPreview', uri);
    await waitFor(() => previewTabs().length >= 1);
    assert.equal(previewTabs().length, 1);
  });

  it('auto-opens a preview when enabled', async () => {
    const config = vscode.workspace.getConfiguration('readMarkdown');
    await config.update('preview.autoOpen', 'beside', vscode.ConfigurationTarget.Global);
    try {
      const doc = await vscode.workspace.openTextDocument(fixture('other.md'));
      await vscode.window.showTextDocument(doc);
      await waitFor(() => previewTabs().some((t) => t.label === 'Preview other.md'));
    } finally {
      await config.update('preview.autoOpen', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
