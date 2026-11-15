import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { pathContextFor, toUri } from '../../src/preview/pathContext';
import { resolveReference } from '../../src/preview/paths';

const WINDOWS = process.platform === 'win32';

// Nothing here stats or opens a path: it only builds URIs and classifies references.
describe('pathContext on the VS Code host', () => {
  it('builds a UNC file URI from its parts', () => {
    const uri = toUri({ scheme: 'file', authority: 'host', path: '/share/dir/x.md' });
    assert.equal(uri.scheme, 'file');
    assert.equal(uri.authority, 'host');
    assert.equal(uri.path, '/share/dir/x.md');
    assert.equal(uri.fsPath, WINDOWS ? '\\\\host\\share\\dir\\x.md' : '//host/share/dir/x.md');
  });

  it('round-trips a drive path', () => {
    const uri = toUri({ scheme: 'file', authority: '', path: '/c:/proj/x.md' });
    assert.equal(uri.authority, '');
    assert.equal(uri.path, '/c:/proj/x.md');
    // VS Code drops the slash in front of a drive letter on every platform; only the separators differ.
    assert.equal(uri.fsPath, WINDOWS ? 'c:\\proj\\x.md' : 'c:/proj/x.md');
  });

  it('classifies a UNC href as a local target outside the allowed roots (Windows host)', function () {
    if (!WINDOWS) this.skip();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'fixture workspace must be open');
    const document = vscode.Uri.file(path.join(folder.uri.fsPath, 'other.md'));
    const ref = resolveReference('\\\\host\\share\\x.md', pathContextFor(document));
    assert.equal(ref.kind, 'local');
    assert.ok(ref.kind === 'local');
    assert.equal(ref.inside, false);
    assert.equal(ref.authority, 'host');
    assert.equal(toUri(ref).fsPath, '\\\\host\\share\\x.md');
  });

  it('classifies a link inside the fixture workspace as inside', () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'fixture workspace must be open');
    const document = vscode.Uri.file(path.join(folder.uri.fsPath, 'other.md'));
    const ref = resolveReference('long-ai-doc.md', pathContextFor(document));
    assert.ok(ref.kind === 'local');
    assert.equal(ref.inside, true);
  });
});
