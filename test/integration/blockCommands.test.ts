import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { PreviewManager } from '../../src/preview/previewManager';
import type { PreviewPanel } from '../../src/preview/previewPanel';
import type { ToWebview } from '../../src/protocol';

const EXTENSION_ID = 'huntertran.read-markdown';

let manager: PreviewManager;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function fixture(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'fixture workspace must be open');
  return vscode.Uri.joinPath(folder.uri, name);
}

/**
 * What a right-click in the preview must never turn into a line: no object, no `rmLine`, or a value that is not a
 * non-negative integer. (`blockLine` in `src/extension.ts`.)
 */
const BAD_CONTEXTS: ReadonlyArray<readonly [string, unknown]> = [
  ['no argument', undefined],
  ['null', null],
  ['an empty object', {}],
  ['a string', '5'],
  ['a number', 5],
  ['an array', [5]],
  ['a URI (the title bar passes one)', vscode.Uri.file('/some/where.md')],
  ['an object without rmLine', { webviewSection: 'rm-block', rmEditable: true }],
  ['rmLine as a string', { rmLine: '5' }],
  ['a negative rmLine', { rmLine: -1 }],
  ['a NaN rmLine', { rmLine: Number.NaN }],
  ['an infinite rmLine', { rmLine: Number.POSITIVE_INFINITY }],
  ['a fractional rmLine', { rmLine: 2.5 }],
  ['a null rmLine', { rmLine: null }],
  ['a boolean rmLine', { rmLine: true }],
  ['an object rmLine', { rmLine: { valueOf: () => 5 } }],
  ['an array rmLine', { rmLine: [5] }],
];

describe('Block context menu commands', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension<{ manager: PreviewManager }>(EXTENSION_ID);
    assert.ok(ext, 'extension should be installed');
    manager = (await ext.activate()).manager;
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  describe('readMarkdown.showSource', () => {
    /** The source is open with the cursor on a sentinel line, and the preview (in another group) is the active panel. */
    async function setUp(sentinel: number): Promise<vscode.TextEditor> {
      const uri = fixture('long-ai-doc.md');
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      editor.selection = new vscode.Selection(sentinel, 0, sentinel, 0);
      const preview = await manager.open(uri, vscode.ViewColumn.Two, false);
      await waitFor(() => manager.lastActivePanel === preview, 'the preview to be the last active panel');
      return editor;
    }

    const cursorLine = (): number | undefined => vscode.window.activeTextEditor?.selection.active.line;

    it('moves the cursor to a valid block line, including line 0', async () => {
      const editor = await setUp(3);
      await vscode.commands.executeCommand('readMarkdown.showSource', { webviewSection: 'rm-block', rmLine: 6 });
      await waitFor(() => vscode.window.activeTextEditor === editor && cursorLine() === 6, 'the cursor at line 6');
      await vscode.commands.executeCommand('readMarkdown.showSource', { rmLine: 0 });
      await waitFor(() => cursorLine() === 0, 'the cursor at line 0');
    });

    for (const [name, context] of BAD_CONTEXTS) {
      it(`does not throw or move the cursor for ${name}`, async () => {
        await setUp(3);
        await vscode.commands.executeCommand('readMarkdown.showSource', context);
        // The source still opens (the command's fallback), at the position it already had.
        await waitFor(
          () => vscode.window.activeTextEditor?.document.uri.toString() === fixture('long-ai-doc.md').toString(),
          'the source editor to be active',
        );
        assert.equal(cursorLine(), 3, 'the cursor stayed where it was');
      });
    }

    it('does nothing without a preview', async () => {
      await waitFor(() => manager.lastActivePanel === undefined, 'no preview to be tracked');
      await vscode.commands.executeCommand('readMarkdown.showSource', { rmLine: 4 });
      await vscode.commands.executeCommand('readMarkdown.showSource', undefined);
      await sleep(200);
      assert.equal(vscode.window.visibleTextEditors.length, 0, 'no editor was opened');
    });
  });

  describe('readMarkdown.editBlock', () => {
    function record(preview: PreviewPanel): ToWebview[] {
      const webview = preview.panel.webview;
      const original = webview.postMessage.bind(webview);
      const log: ToWebview[] = [];
      webview.postMessage = (message: unknown) => {
        log.push(message as ToWebview);
        return original(message);
      };
      return log;
    }

    /**
     * An open preview whose webview is ready (it has been sent the document), with its outgoing messages recorded.
     * The page is reloaded so a `ready` that arrives after the recorder is installed is certain; a reload that
     * is slow to load is retried instead of waiting for it ever longer.
     */
    async function openReady(): Promise<ToWebview[]> {
      const preview = await manager.open(fixture('long-ai-doc.md'), vscode.ViewColumn.Active, false);
      const log = record(preview);
      for (let attempt = 1; ; attempt++) {
        preview.reloadWebview();
        try {
          await waitFor(() => log.some((m) => m.type === 'render'), 'the webview to receive the document', 5000);
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
        }
      }
      await waitFor(() => manager.lastActivePanel === preview, 'the preview to be the last active panel');
      return log;
    }

    const startEdits = (log: readonly ToWebview[]): number[] =>
      log.flatMap((m) => (m.type === 'startEdit' ? [m.line] : []));

    it('asks the preview to edit the block at a valid line, including line 0', async () => {
      const log = await openReady();
      await vscode.commands.executeCommand('readMarkdown.editBlock', { webviewSection: 'rm-block', rmLine: 4, rmEditable: true });
      await vscode.commands.executeCommand('readMarkdown.editBlock', { rmLine: 0 });
      // `post` is synchronous once the webview is ready, so the messages are in the log when the command resolves.
      assert.deepEqual(startEdits(log), [4, 0]);
    });

    it('does not throw or start an edit for a context without a usable line', async () => {
      const log = await openReady();
      // Positive control in the same preview: the recorder sees a good call.
      await vscode.commands.executeCommand('readMarkdown.editBlock', { rmLine: 1 });
      assert.deepEqual(startEdits(log), [1], 'precondition: a valid line is posted');
      log.length = 0;

      for (const [name, context] of BAD_CONTEXTS) {
        await vscode.commands.executeCommand('readMarkdown.editBlock', context);
        assert.deepEqual(startEdits(log), [], `no startEdit message for ${name}`);
      }
    });

    it('does nothing without a preview', async () => {
      await waitFor(() => manager.lastActivePanel === undefined, 'no preview to be tracked');
      await vscode.commands.executeCommand('readMarkdown.editBlock', { rmLine: 4 });
      await vscode.commands.executeCommand('readMarkdown.editBlock');
      assert.equal(vscode.window.visibleTextEditors.length, 0);
    });
  });
});
