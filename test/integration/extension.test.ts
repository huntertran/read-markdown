import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyBlockEdit, moveListItemEdit, readBlock, toggleTask } from '../../src/edit/blockEdit';
import { GitBaseline } from '../../src/scm/gitBaseline';

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
    for (const c of ['readMarkdown.openPreview', 'readMarkdown.openPreviewToSide', 'readMarkdown.toggleNav', 'readMarkdown.toggleChanges', 'readMarkdown.showSource', 'readMarkdown.editBlock']) {
      assert.ok(commands.includes(c), `missing command ${c}`);
    }
  });

  it('shows the source at the line of a block right-clicked in the preview', async () => {
    const uri = fixture('long-ai-doc.md');
    await vscode.commands.executeCommand('readMarkdown.openPreview', uri);
    await waitFor(() => previewTabs().length === 1);
    // What VS Code passes from the webview/context menu (data-vscode-context merged up to <body>).
    await vscode.commands.executeCommand('readMarkdown.showSource', { webviewSection: 'rm-block', rmLine: 5, rmEditable: false });
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString());
    assert.equal(vscode.window.activeTextEditor?.selection.active.line, 5);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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

  describe('block editing', () => {
    async function untitled(content: string): Promise<vscode.TextDocument> {
      return vscode.workspace.openTextDocument({ language: 'markdown', content });
    }

    it('reads a block and replaces it with an undoable edit', async () => {
      const doc = await untitled('# Title\n\n- a\n- b\n\nlast para\n');
      await vscode.window.showTextDocument(doc);
      assert.deepEqual(readBlock(doc, 2, 5, doc.version), { text: '- a\n- b' });

      const result = await applyBlockEdit(doc, 2, 5, doc.version, '- a\n- b\n- c');
      assert.deepEqual(result, { ok: true });
      assert.equal(doc.getText(), '# Title\n\n- a\n- b\n- c\n\nlast para\n');

      await vscode.commands.executeCommand('undo');
      await waitFor(() => doc.getText() === '# Title\n\n- a\n- b\n\nlast para\n');
      // Untitled documents are dirty; close without a save prompt.
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });

    it('keeps CRLF line endings', async () => {
      const doc = await untitled('one\r\n\r\ntwo\r\n');
      assert.equal(doc.eol, vscode.EndOfLine.CRLF);
      assert.deepEqual(await applyBlockEdit(doc, 2, 3, doc.version, 'two\nthree'), { ok: true });
      assert.equal(doc.getText(), 'one\r\n\r\ntwo\r\nthree\r\n');
    });

    it('moves a list item as one undoable edit', async () => {
      const original = '# Tasks\r\n\r\n1. [ ] one\r\n2. [x] two\r\n   more\r\n3. [ ] three\r\n\r\nafter\r\n';
      const doc = await untitled(original);
      await vscode.window.showTextDocument(doc);
      // Items start at lines 2, 3 and 5; the list ends at line 7 (after its trailing blank line).
      assert.deepEqual(await moveListItemEdit(doc, [2, 3, 5], 7, 2, 0, doc.version), { ok: true, line: 2 });
      assert.equal(doc.getText(), '# Tasks\r\n\r\n1. [ ] three\r\n2. [ ] one\r\n3. [x] two\r\n   more\r\n\r\nafter\r\n');

      await vscode.commands.executeCommand('undo');
      await waitFor(() => doc.getText() === original);
      assert.deepEqual(await moveListItemEdit(doc, [2, 3, 5], 7, 0, 1, doc.version - 1), { ok: false, error: 'stale' });
      assert.deepEqual(await moveListItemEdit(doc, [2, 4, 5], 7, 0, 1, doc.version), { ok: false, error: 'invalid' });
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });

    it('toggles a task checkbox by rewriting only its state character', async () => {
      const doc = await untitled('- [ ] one\n- [x] two\n> - [ ] quoted\n');
      assert.deepEqual(await toggleTask(doc, 0, true, doc.version), { ok: true });
      assert.deepEqual(await toggleTask(doc, 1, false, doc.version), { ok: true });
      assert.deepEqual(await toggleTask(doc, 2, true, doc.version), { ok: true });
      assert.equal(doc.getText(), '- [x] one\n- [ ] two\n> - [x] quoted\n');
      // Already in the requested state: no edit, no version bump.
      const version = doc.version;
      assert.deepEqual(await toggleTask(doc, 0, true, version), { ok: true });
      assert.equal(doc.version, version);
      // Not a task line, out of range, stale.
      assert.deepEqual(await toggleTask(doc, 3, true, version), { ok: false, error: 'invalid' });
      assert.deepEqual(await toggleTask(doc, 9, true, version), { ok: false, error: 'invalid' });
      assert.deepEqual(await toggleTask(doc, 0, false, version - 1), { ok: false, error: 'stale' });
    });

    it('rejects edits against a stale version or a bad range', async () => {
      const doc = await untitled('para\n');
      const version = doc.version;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), 'x');
      await vscode.workspace.applyEdit(edit);
      assert.deepEqual(await applyBlockEdit(doc, 0, 1, version, 'new'), { ok: false, error: 'stale' });
      assert.deepEqual(readBlock(doc, 0, 1, version), { error: 'stale' });
      assert.deepEqual(await applyBlockEdit(doc, 0, 9, doc.version, 'new'), { ok: false, error: 'invalid' });
      assert.equal(doc.getText(), 'xpara\n');
    });
  });

  it('has no git baseline for documents that are not files', async () => {
    const baseline = new GitBaseline();
    try {
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: '# x\n' });
      assert.equal(await baseline.getOriginal(doc.uri), undefined);
      // Toggling with no preview open is a no-op, not an error.
      await vscode.commands.executeCommand('readMarkdown.toggleChanges');
    } finally {
      baseline.dispose();
    }
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
