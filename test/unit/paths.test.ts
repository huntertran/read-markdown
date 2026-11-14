import * as assert from 'node:assert/strict';
import { type PathContext, type Reference, allowedRoots, isInsideRoots, resolveReference } from '../../src/preview/paths';

// All paths are written the way `vscode.Uri.path` has them on every platform: POSIX separators, `/c:/dir` drives.
const POSIX: PathContext = {
  document: { scheme: 'file', authority: '', path: '/home/u/proj/docs/guide.md' },
  workspaceFolders: [{ scheme: 'file', authority: '', path: '/home/u/proj' }],
};
const WIN: PathContext = {
  document: { scheme: 'file', authority: '', path: '/c:/proj/docs/guide.md' },
  workspaceFolders: [{ scheme: 'file', authority: '', path: '/c:/proj' }],
  windows: true,
};

type Local = Extract<Reference, { kind: 'local' }>;

function local(ref: string, ctx: PathContext = POSIX): Local {
  const r = resolveReference(ref, ctx);
  assert.equal(r.kind, 'local', `${ref} -> ${JSON.stringify(r)}`);
  return r;
}

describe('resolveReference: document-relative paths', () => {
  it('resolves next to the document', () => {
    for (const ref of ['x.md', './x.md', 'sub/../x.md']) {
      const r = local(ref);
      assert.equal(r.path, '/home/u/proj/docs/x.md', ref);
      assert.equal(r.via, 'relative');
      assert.equal(r.inside, true);
    }
    assert.equal(local('img/x.png').path, '/home/u/proj/docs/img/x.png');
  });

  it('resolves .. and reports a target outside the roots', () => {
    const up = local('../x.md');
    assert.equal(up.path, '/home/u/proj/x.md');
    assert.equal(up.inside, true);
    const out = local('../../outside.md');
    assert.equal(out.path, '/home/u/outside.md');
    assert.equal(out.inside, false);
    assert.equal(local('../../../../../etc/passwd').path, '/etc/passwd');
  });

  it('keeps the document folder as a root when there is no workspace', () => {
    const ctx = { ...POSIX, workspaceFolders: [] };
    assert.equal(local('x.md', ctx).inside, true);
    assert.equal(local('../x.md', ctx).inside, false);
  });

  it('keeps a trailing slash and treats the empty path of a query as the document folder', () => {
    assert.equal(local('img/').path, '/home/u/proj/docs/img/');
    assert.equal(local('?x=1').path, '/home/u/proj/docs');
  });

  it('keeps whitespace as part of the path', () => {
    assert.equal(local('   ').path, '/home/u/proj/docs/   ');
  });
});

describe('resolveReference: workspace-absolute paths', () => {
  it('resolves against the workspace folder of the document', () => {
    const r = local('/docs/x.md');
    assert.equal(r.via, 'workspace-root');
    assert.equal(r.path, '/home/u/proj/docs/x.md');
    assert.equal(r.inside, true);
  });

  it('picks the deepest folder containing the document, else the first folder', () => {
    const ctx: PathContext = {
      ...POSIX,
      workspaceFolders: [
        { scheme: 'file', authority: '', path: '/other' },
        { scheme: 'file', authority: '', path: '/home/u/proj' },
        { scheme: 'file', authority: '', path: '/home/u/proj/docs' },
      ],
    };
    assert.equal(local('/x.md', ctx).path, '/home/u/proj/docs/x.md');
    const outsideDoc = { ...ctx, document: { scheme: 'file', authority: '', path: '/elsewhere/a.md' } };
    assert.equal(local('/x.md', outsideDoc).path, '/other/x.md');
  });

  it('does not let .. climb out unnoticed', () => {
    const r = local('/../../etc/passwd');
    assert.equal(r.path, '/home/etc/passwd');
    assert.equal(r.inside, false);
  });

  it('is a plain file path without a workspace folder', () => {
    const ctx = { ...POSIX, workspaceFolders: [] };
    const r = local('/etc/hosts', ctx);
    assert.deepEqual([r.scheme, r.authority, r.path, r.inside], ['file', '', '/etc/hosts', false]);
  });

  it('reads //host/share/x as a UNC path only without a workspace folder', () => {
    const r = local('//host/share/x.md', { ...POSIX, workspaceFolders: [] });
    assert.deepEqual([r.authority, r.path], ['host', '/share/x.md']);
    assert.equal(local('//host/share/x.md').path, '/home/u/proj/host/share/x.md');
  });
});

describe('resolveReference: file: URIs', () => {
  it('reads path, authority, query and fragment', () => {
    const r = local('file:///etc/passwd');
    assert.deepEqual([r.via, r.scheme, r.authority, r.path, r.inside], ['file-uri', 'file', '', '/etc/passwd', false]);
    const h = local('file://host/share/x.md?a=1#top');
    assert.deepEqual([h.authority, h.path, h.query, h.fragment], ['host', '/share/x.md', 'a=1', 'top']);
  });

  it('keeps a Windows drive path and is inside when below a root', () => {
    const r = local('file:///c:/proj/docs/x.md', WIN);
    assert.equal(r.path, '/c:/proj/docs/x.md');
    assert.equal(r.inside, true);
    assert.equal(local('file:///c:/x.md', WIN).inside, false);
  });

  it('decodes escapes, leaving a malformed one as written', () => {
    assert.equal(local('file:///a%20b/%E4%B8%AD.md').path, '/a b/\u4e2d.md');
    assert.equal(local('file:///a/%E0%A4%A.md').path, '/a/%E0%A4%A.md');
  });

  it('normalises .. before checking the roots', () => {
    const r = local('file:///home/u/proj/../x.md');
    assert.equal(r.path, '/home/u/x.md');
    assert.equal(r.inside, false);
  });

  it('is case-insensitive in the scheme', () => {
    assert.equal(local('FILE:///etc/passwd').path, '/etc/passwd');
  });
});

describe('resolveReference: Windows and UNC references', () => {
  it('turns backslashes into separators on Windows only', () => {
    assert.equal(local('img\\x.png', WIN).path, '/c:/proj/docs/img/x.png');
    assert.equal(local('..\\x.md', WIN).path, '/c:/proj/x.md');
    assert.equal(local('img\\x.png').path, '/home/u/proj/docs/img\\x.png');
  });

  it('reads \\\\host\\share\\x.md as a UNC path on Windows, a file name elsewhere', () => {
    const r = local('\\\\host\\share\\x.md', WIN);
    assert.deepEqual([r.scheme, r.authority, r.path, r.inside], ['file', 'host', '/share/x.md', false]);
    assert.equal(local('\\\\host\\share\\x.md').path, '/home/u/proj/docs/\\\\host\\share\\x.md');
  });

  it('reads //host/share/x.md as workspace-relative, as /-paths are', () => {
    assert.equal(local('//host/share/x.md', WIN).path, '/c:/proj/host/share/x.md');
  });

  it('reads \\x as the root of the document drive on Windows', () => {
    assert.equal(local('\\x\\y.md', WIN).path, '/c:/x/y.md');
  });

  it('stops .. at the drive root and at a UNC share root', () => {
    assert.equal(local('..\\..\\..\\..\\x.md', WIN).path, '/c:/x.md');
    const unc: PathContext = {
      document: { scheme: 'file', authority: 'host', path: '/share/docs/a.md' },
      workspaceFolders: [],
      windows: true,
    };
    assert.deepEqual([local('../../../x.md', unc).authority, local('../../../x.md', unc).path], ['host', '/share/x.md']);
  });

  it('does not open drive paths written in a document (the drive is a scheme)', () => {
    for (const ref of ['C:\\x\\y.md', 'c:/x/y.md']) {
      assert.deepEqual(resolveReference(ref, WIN), { kind: 'unsupported', scheme: 'c' });
    }
  });
});

describe('resolveReference: percent-encoding', () => {
  it('decodes the path once', () => {
    assert.equal(local('my%20file%2B1.md').path, '/home/u/proj/docs/my file+1.md');
    assert.equal(local('%2541.md').path, '/home/u/proj/docs/%41.md');
  });

  it('keeps a path with a malformed escape as written instead of throwing', () => {
    assert.equal(local('a%E0%A4%A.md').path, '/home/u/proj/docs/a%E0%A4%A.md');
  });

  it('normalises after decoding, so encoded traversal is caught', () => {
    for (const ref of ['..%2F..%2Foutside.md', '%2e%2e/%2e%2e/outside.md', '%2E%2E%2f%2E%2E%2foutside.md']) {
      const r = local(ref);
      assert.equal(r.path, '/home/u/outside.md', ref);
      assert.equal(r.inside, false, ref);
    }
    assert.equal(local('/%2e%2e/%2e%2e/etc/passwd').inside, false);
  });

  it('decodes %5C to a separator on Windows, as the old code did', () => {
    assert.equal(local('..%5Cx.md', WIN).path, '/c:/proj/x.md');
  });
});

describe('resolveReference: query and fragment', () => {
  it('splits a query and a fragment off the path', () => {
    const r = local('a.md?x=1#frag');
    assert.deepEqual([r.path, r.query, r.fragment], ['/home/u/proj/docs/a.md', 'x=1', 'frag']);
  });

  it('treats a ? after the # as part of the fragment', () => {
    const r = local('a.md#frag?notquery');
    assert.deepEqual([r.path, r.query, r.fragment], ['/home/u/proj/docs/a.md', '', 'frag?notquery']);
  });

  it('decodes the fragment, keeping a malformed one as written', () => {
    assert.equal(local('a.md#%E4%B8%AD').fragment, '\u4e2d');
    assert.equal(local('a.md#%E0%A4%A').fragment, '%E0%A4%A');
    assert.deepEqual(resolveReference('#%E0%A4%A', POSIX), { kind: 'fragment', fragment: '%E0%A4%A' });
  });

  it('returns a fragment-only reference as the document itself', () => {
    assert.deepEqual(resolveReference('#frag', POSIX), { kind: 'fragment', fragment: 'frag' });
    assert.deepEqual(resolveReference('#', POSIX), { kind: 'fragment', fragment: '' });
  });

  it('keeps an image query out of the path', () => {
    assert.equal(local('img/x.png?raw=1').path, '/home/u/proj/docs/img/x.png');
  });
});

describe('resolveReference: schemes and empty references', () => {
  it('passes web and mail links on', () => {
    assert.deepEqual(resolveReference('https://example.com/a', POSIX), { kind: 'external', scheme: 'https' });
    assert.deepEqual(resolveReference('HTTP://example.com', POSIX), { kind: 'external', scheme: 'http' });
    assert.deepEqual(resolveReference('mailto:a@b.c', POSIX), { kind: 'external', scheme: 'mailto' });
  });

  it('does not open other schemes', () => {
    for (const ref of ['command:workbench.action.reload', 'vscode://x/y', 'javascript:alert(1)', 'data:text/plain,x']) {
      assert.equal(resolveReference(ref, POSIX).kind, 'unsupported', ref);
    }
  });

  it('rejects an empty reference', () => {
    assert.deepEqual(resolveReference('', POSIX), { kind: 'invalid', reason: 'empty' });
  });
});

describe('resolveReference: documents that are not local files', () => {
  const remote: PathContext = {
    document: { scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/srv/proj/docs/guide.md' },
    workspaceFolders: [{ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/srv/proj' }],
    windows: true, // a local-file flag: must not apply here
  };

  it('keeps scheme and authority, relative to the document folder', () => {
    const r = local('../img/x.png', remote);
    assert.deepEqual([r.scheme, r.authority, r.path, r.inside], ['vscode-remote', 'ssh-remote+box', '/srv/proj/img/x.png', true]);
    assert.equal(local('..\\x.md', remote).path, '/srv/proj/docs/..\\x.md');
    assert.equal(local('../../../x.md', remote).inside, false);
  });

  it('is not inside a root of another host', () => {
    const other = { ...remote, document: { ...remote.document, authority: 'ssh-remote+other' } };
    assert.equal(local('x.md', other).inside, false);
  });

  it('resolves workspace-absolute paths in the folder of the remote workspace', () => {
    const r = local('/docs/x.md', remote);
    assert.deepEqual([r.scheme, r.authority, r.path], ['vscode-remote', 'ssh-remote+box', '/srv/proj/docs/x.md']);
  });

  it('starts relative paths at the first workspace folder with relativeBase "workspace"', () => {
    const r = local('img/x.png', { ...remote, relativeBase: 'workspace' });
    assert.equal(r.path, '/srv/proj/img/x.png');
    assert.deepEqual(resolveReference('img/x.png', { ...remote, relativeBase: 'workspace', workspaceFolders: [] }), {
      kind: 'invalid',
      reason: 'no-base',
    });
    // Local files are unaffected by it.
    assert.equal(local('x.md', { ...POSIX, relativeBase: 'workspace' }).path, '/home/u/proj/docs/x.md');
  });

  describe('untitled documents', () => {
    const untitled: PathContext = {
      document: { scheme: 'untitled', authority: '', path: 'Untitled-1' },
      workspaceFolders: [{ scheme: 'file', authority: '', path: '/home/u/proj' }],
    };

    it('have no folder: a relative path stays relative and is outside every root', () => {
      const r = local('notes/x.md', untitled);
      assert.deepEqual([r.scheme, r.path, r.inside], ['untitled', 'notes/x.md', false]);
    });

    it('still resolve workspace-absolute paths', () => {
      assert.equal(local('/docs/x.md', untitled).path, '/home/u/proj/docs/x.md');
      assert.equal(local('/docs/x.md', untitled).inside, true);
    });

    it('resolve images against the workspace folder with relativeBase "workspace"', () => {
      assert.equal(local('img/x.png', { ...untitled, relativeBase: 'workspace' }).path, '/home/u/proj/img/x.png');
    });
  });
});

describe('allowedRoots', () => {
  it('lists the document folder (local files only) and the workspace folders', () => {
    assert.deepEqual(allowedRoots(POSIX), [
      { scheme: 'file', authority: '', path: '/home/u/proj/docs' },
      { scheme: 'file', authority: '', path: '/home/u/proj' },
    ]);
    assert.deepEqual(
      allowedRoots({ ...POSIX, document: { scheme: 'untitled', authority: '', path: 'Untitled-1' } }),
      POSIX.workspaceFolders,
    );
  });
});

describe('isInsideRoots', () => {
  const root = { scheme: 'file', authority: '', path: '/a/b' };
  const at = (p: string, authority = '', scheme = 'file') => ({ scheme, authority, path: p });

  it('counts the root itself and everything below it', () => {
    assert.equal(isInsideRoots(at('/a/b'), [root]), true);
    assert.equal(isInsideRoots(at('/a/b/'), [root]), true);
    assert.equal(isInsideRoots(at('/a/b/c/d.md'), [root]), true);
    assert.equal(isInsideRoots(at('/a/b/c/../d.md'), [root]), true);
  });

  it('does not confuse a root with a sibling that starts with its name', () => {
    assert.equal(isInsideRoots(at('/a/bc'), [root]), false);
    assert.equal(isInsideRoots(at('/a/bc/x.md'), [root]), false);
    assert.equal(isInsideRoots(at('/a'), [root]), false);
  });

  it('normalises before comparing', () => {
    assert.equal(isInsideRoots(at('/a/b/../c'), [root]), false);
    assert.equal(isInsideRoots(at('/a/b/../b/x'), [root]), true);
    assert.equal(isInsideRoots(at('/a/b/..'), [root]), false);
  });

  it('ignores a trailing slash on the root', () => {
    assert.equal(isInsideRoots(at('/a/b/x'), [at('/a/b/')]), true);
    assert.equal(isInsideRoots(at('/a/bc'), [at('/a/b/')]), false);
  });

  it('lets the root / contain everything on its file system', () => {
    assert.equal(isInsideRoots(at('/etc/passwd'), [at('/')]), true);
  });

  it('requires the same scheme and authority', () => {
    assert.equal(isInsideRoots(at('/a/b/x', '', 'vscode-remote'), [root]), false);
    assert.equal(isInsideRoots(at('/a/b/x', 'host'), [root]), false);
    assert.equal(isInsideRoots(at('/a/b/x', 'HOST'), [at('/a/b', 'host')]), true);
  });

  it('folds the drive letter case always, the rest of a local path only when case-insensitive', () => {
    const drive = [at('/c:/Proj')];
    assert.equal(isInsideRoots(at('/C:/Proj/x.md'), drive), true);
    assert.equal(isInsideRoots(at('/c:/proj/x.md'), drive), false);
    assert.equal(isInsideRoots(at('/c:/proj/x.md'), drive, { caseInsensitive: true }), true);
    assert.equal(isInsideRoots(at('/C:/PROJ/x.md'), drive, { windows: true }), true);
    // Never for other schemes: their file systems are not known to ignore case.
    assert.equal(isInsideRoots(at('/proj/X', '', 'vscode-remote'), [at('/proj/x', '', 'vscode-remote')], { caseInsensitive: true }), false);
  });

  it('is inside with a Windows document written in the other drive-letter case', () => {
    const upper: PathContext = { ...WIN, workspaceFolders: [{ scheme: 'file', authority: '', path: '/C:/proj' }] };
    assert.equal(local('x.md', upper).inside, true);
    assert.equal(local('file:///c:/PROJ/x.md', upper).inside, true);
    assert.equal(local('file:///c:/PROJ/x.md', { ...upper, caseInsensitive: false }).inside, false);
  });
});
