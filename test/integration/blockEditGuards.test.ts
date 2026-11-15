import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { applyBlockEdit, moveListItemEdit, readBlock, toggleTask } from '../../src/edit/blockEdit';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const SOURCE = '# Title\n\n- [ ] one\n- two\n\npara\n';

/** A tiny in-memory file system for one scheme; `isReadonly` is what `isWritableFileSystem(scheme)` reports. */
class MemoryFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly files = new Map<string, Uint8Array>();

  constructor(private readonly content: string) {}

  private bytes(uri: vscode.Uri): Uint8Array {
    return this.files.get(uri.path) ?? new TextEncoder().encode(this.content);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: this.bytes(uri).length };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {}

  readFile(uri: vscode.Uri): Uint8Array {
    return this.bytes(uri);
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    this.files.set(uri.path, content);
  }

  delete(): void {}

  rename(): void {}

  dispose(): void {
    this.emitter.dispose();
  }
}

describe('Block edit guards', () => {
  const disposables: vscode.Disposable[] = [];

  /** Registers a scheme and waits until the extension host knows whether it is writable. */
  async function openOnScheme(scheme: string, isReadonly: boolean): Promise<vscode.TextDocument> {
    const fileSystem = new MemoryFileSystem(SOURCE);
    disposables.push(
      fileSystem,
      vscode.workspace.registerFileSystemProvider(scheme, fileSystem, { isCaseSensitive: true, isReadonly }),
    );
    await waitFor(
      () => vscode.workspace.fs.isWritableFileSystem(scheme) === !isReadonly,
      `isWritableFileSystem(${scheme}) to be ${!isReadonly}`,
    );
    return vscode.workspace.openTextDocument(vscode.Uri.from({ scheme, path: '/doc.md' }));
  }

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const d of disposables.splice(0)) d.dispose();
  });

  // The `failed` result (`applyEdit` resolving to false or rejecting, src/edit/blockEdit.ts `replace`) is deliberately
  // not covered here. In VS Code 1.146 no document a test can create makes `applyEdit` fail: a content-provider
  // document, a file listed in `files.readonlyInclude` (also while shown in an editor), a file deleted from disk and
  // a document whose file system provider was unregistered all accept the edit in memory. Forcing it would need a
  // fake TextDocument object or a production seam.

  describe('readonly', () => {
    it('refuses to read, edit, toggle and move on a read-only file system', async () => {
      const doc = await openOnScheme('rm-readonly', true);
      assert.equal(doc.getText(), SOURCE, 'precondition: the document has its content');
      const version = doc.version;

      assert.deepEqual(readBlock(doc, 2, 4, version), { error: 'readonly' });
      assert.deepEqual(await applyBlockEdit(doc, 2, 4, version, '- [ ] changed'), { ok: false, error: 'readonly' });
      assert.deepEqual(await toggleTask(doc, 2, true, version), { ok: false, error: 'readonly' });
      assert.deepEqual(await moveListItemEdit(doc, [2, 3], 4, 0, 1, version), { ok: false, error: 'readonly' });

      assert.equal(doc.getText(), SOURCE, 'nothing was changed');
      assert.equal(doc.version, version);
    });

    it('allows the same operations on a writable file system', async () => {
      const doc = await openOnScheme('rm-writable', false);
      const version = doc.version;

      // Edits that change nothing: they pass every check and return before a WorkspaceEdit, so the document
      // stays clean (a dirty document on a throw-away scheme only makes the workbench complain on shutdown).
      assert.deepEqual(readBlock(doc, 2, 4, version), { text: '- [ ] one\n- two' });
      assert.deepEqual(await applyBlockEdit(doc, 2, 4, version, '- [ ] one\n- two'), { ok: true });
      assert.deepEqual(await toggleTask(doc, 2, false, version), { ok: true });
      assert.equal(doc.version, version);
    });

    it('treats a scheme with no registered provider (untitled) as editable', async () => {
      // `isWritableFileSystem` reports `undefined` for it, which is not "read-only".
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: SOURCE });
      assert.equal(vscode.workspace.fs.isWritableFileSystem(doc.uri.scheme), undefined);
      assert.deepEqual(readBlock(doc, 2, 4, doc.version), { text: '- [ ] one\n- two' });
      assert.deepEqual(await applyBlockEdit(doc, 5, 6, doc.version, 'changed'), { ok: true });
      assert.equal(doc.getText(), '# Title\n\n- [ ] one\n- two\n\nchanged\n');
    });

    it('reports a stale version or an invalid range before a read-only file system', async () => {
      const doc = await openOnScheme('rm-readonly-order', true);
      const version = doc.version;
      assert.deepEqual(readBlock(doc, 2, 4, version + 1), { error: 'stale' });
      assert.deepEqual(readBlock(doc, 2, 99, version), { error: 'invalid' });
      assert.deepEqual(await applyBlockEdit(doc, 2, 4, version + 1, 'x'), { ok: false, error: 'stale' });
      assert.deepEqual(await applyBlockEdit(doc, 4, 2, version, 'x'), { ok: false, error: 'invalid' });
      assert.deepEqual(await toggleTask(doc, 2, true, version + 1), { ok: false, error: 'stale' });
      assert.deepEqual(await toggleTask(doc, 99, true, version), { ok: false, error: 'invalid' });
      assert.deepEqual(await moveListItemEdit(doc, [2], 4, 0, 1, version), { ok: false, error: 'invalid' });
    });
  });
});
