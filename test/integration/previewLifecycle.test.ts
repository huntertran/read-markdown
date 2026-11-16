import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION, getSettings } from '../../src/config/settings';
import type { PreviewManager } from '../../src/preview/previewManager';
import { PREVIEW_VIEW_TYPE } from '../../src/preview/previewPanel';
import type { WebviewState } from '../../src/protocol';

const EXTENSION_ID = 'huntertran.read-markdown';
const CUSTOM_EDITOR = 'readMarkdown.editor';
const AUTO_OPEN = 'preview.autoOpen';

let manager: PreviewManager;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Long enough for a (wrongly) triggered auto-open to have shown its tab; only used for "nothing happens". */
const GRACE_MS = 700;

/** Tabs of the preview panels (`open` / auto-open); the custom editor is a `TabInputCustom`, not listed here. */
function previewTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes(PREVIEW_VIEW_TYPE));
}

function customEditorTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === CUSTOM_EDITOR);
}

const hasPreviewTab = (label: string): boolean => previewTabs().some((t) => t.label === label);

describe('Preview lifecycle', () => {
  const tempDirs: string[] = [];
  const busyDirs: string[] = [];
  const disposables: vscode.Disposable[] = [];
  let savedAutoOpen: unknown;

  /** A temp file with its own URI: `autoOpened` is remembered per URI for the life of the extension host. */
  function tempFile(name: string, content = '# Title\n\nSome text.\n'): vscode.Uri {
    let dir = tempDirs[0];
    if (!dir) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-life-'));
      tempDirs.push(dir);
    }
    const unique = fs.mkdtempSync(path.join(dir, 'case-'));
    const file = path.join(unique, name);
    fs.writeFileSync(file, content);
    return vscode.Uri.file(file);
  }

  /** Writes the user-scope mode and waits until the live manager has read it. */
  async function setMode(mode: string | undefined): Promise<void> {
    await vscode.workspace.getConfiguration(SECTION).update(AUTO_OPEN, mode, vscode.ConfigurationTarget.Global);
    await waitFor(() => manager.settings.autoOpen === getSettings().autoOpen, 'the manager to read preview.autoOpen');
  }

  async function show(uri: vscode.Uri, column = vscode.ViewColumn.One): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(doc, column);
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<{ manager: PreviewManager }>(EXTENSION_ID);
    assert.ok(ext, 'extension should be installed');
    manager = (await ext.activate()).manager;
    savedAutoOpen = vscode.workspace.getConfiguration(SECTION).inspect<string>(AUTO_OPEN)?.globalValue;
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const d of disposables.splice(0)) d.dispose();
    await vscode.workspace.getConfiguration(SECTION).update(AUTO_OPEN, savedAutoOpen, vscode.ConfigurationTarget.Global);
    // VS Code 1.90 can still hold a folder it watched for a just-closed preview (EBUSY on Windows): the folder
    // is a throw-away in the OS temp directory, so try again once at the end and otherwise leave it.
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        busyDirs.push(dir);
      }
    }
  });

  after(() => {
    for (const dir of busyDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // Still held by the host; the OS cleans its temp directory.
      }
    }
  });

  describe('restore after a reload (PreviewManager.restore)', () => {
    /** A panel as VS Code hands it to the serializer; `isDisposed()` tells whether the manager disposed it. */
    function newPanel(): { panel: vscode.WebviewPanel; isDisposed: () => boolean } {
      const panel = vscode.window.createWebviewPanel(
        PREVIEW_VIEW_TYPE,
        'To be restored',
        { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
        { enableScripts: true },
      );
      let disposed = false;
      panel.onDidDispose(() => {
        disposed = true;
      });
      disposables.push(panel);
      return { panel, isDisposed: () => disposed };
    }

    it('disposes the panel for a state without a usable uri', async () => {
      const bad: unknown[] = [undefined, {}, { uri: '' }, { uri: 42 }, { uri: null }, { uri: 'no/scheme/just/a/path.md' }, { scrollLine: 3 }];
      for (const state of bad) {
        const { panel, isDisposed } = newPanel();
        await manager.restore(panel, state as WebviewState | undefined);
        await waitFor(isDisposed, `the panel to be disposed for ${JSON.stringify(state)}`);
      }
      await waitFor(() => previewTabs().length === 0, 'the disposed panels to leave the tab bar');
    });

    it('disposes the panel for a scheme the extension does not preview, without opening the document', async () => {
      let provided = 0;
      disposables.push(
        vscode.workspace.registerTextDocumentContentProvider('rm-norestore', {
          provideTextDocumentContent: () => {
            provided++;
            return '# must not be read\n';
          },
        }),
      );
      const uris = [
        'rm-norestore:/doc.md',
        'https://example.com/doc.md',
        'vscode-userdata:/User/settings.json',
        'command:workbench.action.closeAllEditors',
        'javascript:alert(1)',
        'git:/some/doc.md',
      ];
      for (const uri of uris) {
        const { panel, isDisposed } = newPanel();
        await manager.restore(panel, { uri });
        await waitFor(isDisposed, `the panel to be disposed for ${uri}`);
      }
      assert.equal(provided, 0, 'the content provider was never asked for a document');
      assert.ok(
        !vscode.workspace.textDocuments.some((d) => d.uri.scheme === 'rm-norestore'),
        'no document of the rejected scheme was opened',
      );
      await waitFor(() => previewTabs().length === 0, 'the disposed panels to leave the tab bar');
    });

    it('disposes the panel when the document cannot be opened', async () => {
      const missing = tempFile('gone.md');
      fs.rmSync(missing.fsPath);
      const { panel, isDisposed } = newPanel();
      await manager.restore(panel, { uri: missing.toString() });
      await waitFor(isDisposed, 'the panel to be disposed for a file that does not exist');
      await waitFor(() => previewTabs().length === 0, 'the disposed panel to leave the tab bar');
    });

    it('attaches a preview to the panel for a valid state and tracks it', async () => {
      const uri = tempFile('restored.md', '# Restored\n\nBody.\n');
      const { panel, isDisposed } = newPanel();
      const posted: string[] = [];
      const original = panel.webview.postMessage.bind(panel.webview);
      panel.webview.postMessage = (message: unknown) => {
        posted.push((message as { type: string }).type);
        return original(message);
      };

      await manager.restore(panel, { uri: uri.toString(), scrollLine: 1 });

      assert.equal(isDisposed(), false, 'the panel is kept');
      assert.equal(panel.title, 'Preview restored.md', 'the preview configured the panel');
      assert.ok(panel.webview.html.includes('Content-Security-Policy'), 'the webview got the extension shell');
      assert.ok(
        panel.webview.options.localResourceRoots?.some((r) => r.fsPath === vscode.Uri.file(path.dirname(uri.fsPath)).fsPath),
        'the document folder is a local resource root',
      );
      // Tracked: opening the same document reuses this very panel instead of creating a second tab.
      const reused = await manager.open(uri, vscode.ViewColumn.One, false);
      assert.equal(reused.panel, panel);
      assert.equal(reused.kind, 'panel');
      assert.equal(reused.uri.toString(), uri.toString());
      assert.equal(previewTabs().length, 1);
      // And it is wired to the webview: after `ready` it gets the config and the document.
      await waitFor(() => posted.includes('config') && posted.includes('render'), 'the restored webview to receive config and render');
    });

    it('stops tracking a restored panel once it is closed', async () => {
      const uri = tempFile('closed.md');
      const { panel } = newPanel();
      await manager.restore(panel, { uri: uri.toString() });
      panel.dispose();
      await waitFor(() => previewTabs().length === 0, 'the panel to close');
      const again = await manager.open(uri, vscode.ViewColumn.One, false);
      assert.notEqual(again.panel, panel, 'a new panel, not the disposed one');
      await waitFor(() => previewTabs().length === 1, 'the new preview tab');
    });
  });

  describe('custom text editor (readMarkdown.editor)', () => {
    async function openCustom(uri: vscode.Uri): Promise<void> {
      await vscode.commands.executeCommand('vscode.openWith', uri, CUSTOM_EDITOR);
      await waitFor(() => customEditorTabs().length > 0, 'the custom editor tab');
    }

    it('opens a markdown file as a custom editor tab with a preview of kind "editor"', async () => {
      const uri = tempFile('custom.md', '# Custom\n\nText.\n');
      await openCustom(uri);

      const tabs = customEditorTabs();
      assert.equal(tabs.length, 1);
      const input = tabs[0].input as vscode.TabInputCustom;
      assert.equal(input.viewType, CUSTOM_EDITOR);
      assert.equal(input.uri.toString(), uri.toString());
      assert.equal(previewTabs().length, 0, 'it is not a regular preview panel');

      await waitFor(() => manager.lastActivePanel?.kind === 'editor', 'the custom editor to be tracked');
      const preview = manager.lastActivePanel;
      assert.ok(preview);
      assert.equal(preview.uri.toString(), uri.toString());
      assert.ok(preview.panel.webview.html.includes('Content-Security-Policy'), 'the webview got the extension shell');
      assert.equal(preview.panel.webview.options.enableScripts, true);
    });

    it('keeps a regular preview of the same document separate from the custom editor', async () => {
      const uri = tempFile('both.md');
      await openCustom(uri);
      await waitFor(() => manager.lastActivePanel?.kind === 'editor', 'the custom editor to be tracked');
      const editorPanel = manager.lastActivePanel;

      const regular = await manager.open(uri, vscode.ViewColumn.Beside, true);
      assert.equal(regular.kind, 'panel');
      assert.notEqual(regular.panel, editorPanel?.panel, 'open() does not reuse the custom editor');
      await waitFor(() => previewTabs().length === 1, 'the regular preview tab');
      assert.equal(customEditorTabs().length, 1);
    });
  });

  describe('auto open (preview.autoOpen)', () => {
    it('opens nothing when the mode is off', async () => {
      const first = tempFile('off-first.md');
      const second = tempFile('off-second.md');
      await setMode('off');
      await show(first);
      await sleep(GRACE_MS);
      assert.equal(previewTabs().length, 0, 'nothing is opened while the mode is off');

      // Not vacuous: with the mode on, the same gesture on another file does open a preview.
      await setMode('beside');
      await show(second);
      await waitFor(() => hasPreviewTab('Preview off-second.md'), 'the preview of the second file');
      assert.ok(!hasPreviewTab('Preview off-first.md'), 'the first file stays without a preview');
    });

    for (const mode of ['active', 'beside']) {
      it(`opens nothing for a non-markdown editor in "${mode}" mode`, async () => {
        const text = tempFile(`notes-${mode}.txt`, 'plain text\n');
        const md = tempFile(`control-${mode}.md`);
        await setMode(mode);
        await show(text);
        await sleep(GRACE_MS);
        assert.equal(previewTabs().length, 0, 'a .txt editor does not open a preview');

        // Not vacuous: a markdown editor does, under the same mode.
        await show(md);
        await waitFor(() => hasPreviewTab(`Preview control-${mode}.md`), 'the preview of the markdown control file');
        assert.equal(previewTabs().length, 1);
      });
    }

    it('opens nothing for a diff of two markdown files, and does not remember the files', async () => {
      const left = tempFile('diff-left.md', '# Left\n');
      const right = tempFile('diff-right.md', '# Right\n');
      await setMode('active');

      await vscode.commands.executeCommand('vscode.diff', left, right, 'left <-> right');
      await waitFor(
        () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff)),
        'the diff tab',
      );
      await sleep(GRACE_MS);
      assert.equal(previewTabs().length, 0, 'a diff editor does not open a preview');

      // The diff must not have used up the one-time auto-open: the same file as a normal editor still opens one.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await show(right);
      await waitFor(() => hasPreviewTab('Preview diff-right.md'), 'the preview once the file is a normal editor');
    });

    it('does not open a second preview for a document that already has one', async () => {
      const uri = tempFile('has-preview.md');
      await setMode('active');
      const existing = await manager.open(uri, vscode.ViewColumn.Beside, true);
      await waitFor(() => previewTabs().length === 1, 'the explicit preview tab');

      await show(uri, vscode.ViewColumn.One);
      await sleep(GRACE_MS);
      assert.equal(previewTabs().length, 1, 'still the one preview');
      assert.equal(await manager.open(uri, vscode.ViewColumn.Beside, true), existing);
    });

    it('does not open a preview next to a custom editor of the same document', async () => {
      const uri = tempFile('has-custom.md');
      await setMode('active');
      await vscode.commands.executeCommand('vscode.openWith', uri, CUSTOM_EDITOR);
      await waitFor(() => customEditorTabs().length === 1, 'the custom editor');

      await show(uri, vscode.ViewColumn.Two);
      await sleep(GRACE_MS);
      assert.equal(previewTabs().length, 0, 'the custom editor already counts as a preview');
    });

    it('does not open the preview again once it was auto-opened and closed', async () => {
      const uri = tempFile('once.md');
      const other = tempFile('once-away.txt', 'elsewhere\n');
      await setMode('active');
      await show(uri);
      await waitFor(() => hasPreviewTab('Preview once.md'), 'the first auto-open');

      const [tab] = previewTabs();
      await vscode.window.tabGroups.close(tab);
      await waitFor(() => previewTabs().length === 0, 'the preview to close');

      // Leave the markdown editor and come back: a fresh active-editor event for the same, still open, document.
      await show(other);
      await show(uri);
      await sleep(GRACE_MS);
      assert.equal(previewTabs().length, 0, 'the closed preview is not reopened');
    });

    it('in "active" mode opens the preview in the editor\'s own group, not beside', async () => {
      const uri = tempFile('same-column.md');
      await setMode('active');
      await show(uri, vscode.ViewColumn.One);
      await waitFor(() => hasPreviewTab('Preview same-column.md'), 'the auto-opened preview');

      assert.equal(vscode.window.tabGroups.all.length, 1, 'no group was created next to the editor');
      const group = vscode.window.tabGroups.all[0];
      assert.equal(group.viewColumn, vscode.ViewColumn.One);
      const labels = group.tabs.map((t) => t.label);
      assert.ok(labels.includes('Preview same-column.md'), `the preview is in the editor's group: ${labels.join(', ')}`);
      assert.ok(labels.includes('same-column.md'), 'the source editor is still there');
      assert.equal(group.activeTab?.label, 'Preview same-column.md', 'the preview takes focus (preserveFocus is false)');
    });

    it('in "active" mode follows the editor to its column', async () => {
      const left = tempFile('left-column.txt', 'left\n');
      const uri = tempFile('second-column.md');
      await show(left, vscode.ViewColumn.One);
      await setMode('active');
      await show(uri, vscode.ViewColumn.Two);
      await waitFor(() => hasPreviewTab('Preview second-column.md'), 'the auto-opened preview');

      const group = vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.label === 'Preview second-column.md'));
      assert.equal(group?.viewColumn, vscode.ViewColumn.Two);
      assert.equal(vscode.window.tabGroups.all.length, 2, 'no third group was created');
      assert.ok(group?.tabs.some((t) => t.label === 'second-column.md'));
    });
  });
});
