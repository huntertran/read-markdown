import * as assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { LinkOpener, type LinkHost, outsideTargetPrompt } from '../../src/preview/linkOpener';
import type { PathContext, UriParts } from '../../src/preview/paths';

/** A stand-in for `vscode.Uri`: the parts plus the `fsPath` / `toString` the opener reads. */
function fakeUri(parts: UriParts, windows: boolean): vscode.Uri {
  const { scheme, authority, path } = parts;
  let fsPath = path;
  if (scheme === 'file' && windows) {
    const drive = /^\/([a-zA-Z]:)(\/.*)?$/.exec(path);
    fsPath = authority ? `\\\\${authority}${path.replace(/\//g, '\\')}` : drive ? `${drive[1]}${(drive[2] ?? '').replace(/\//g, '\\')}` : path;
  } else if (authority) {
    fsPath = `//${authority}${path}`;
  }
  return { scheme, authority, path, fsPath, toString: () => `${scheme}://${authority}${path}` } as unknown as vscode.Uri;
}

const POSIX_DOC = fakeUri({ scheme: 'file', authority: '', path: '/ws/docs/a.md' }, false);
const POSIX_CONTEXT: PathContext = {
  document: POSIX_DOC,
  workspaceFolders: [{ scheme: 'file', authority: '', path: '/ws' }],
  windows: false,
  caseInsensitive: false,
};
const WIN_DOC = fakeUri({ scheme: 'file', authority: '', path: '/c:/ws/docs/a.md' }, true);
const WIN_CONTEXT: PathContext = {
  document: WIN_DOC,
  workspaceFolders: [{ scheme: 'file', authority: '', path: '/c:/ws' }],
  windows: true,
  caseInsensitive: true,
};

interface Options {
  context?: PathContext;
  /** What `confirm` does: resolve true (default), resolve false, reject, or wait for `confirmGate.resolve`. */
  confirm?: 'yes' | 'no' | 'reject' | 'gate';
  statRejects?: boolean;
  openPreviewRejects?: boolean;
  openFileRejects?: boolean;
  openExternalRejects?: boolean;
}

interface Setup {
  opener: LinkOpener;
  /** Order of the port calls: `confirm`, `stat`, `openPreview`, `reveal:<slug>`, `openFile`, ... */
  calls: string[];
  confirmed: UriParts[];
  stated: UriParts[];
  previews: UriParts[];
  files: UriParts[];
  /** For `confirm: 'gate'`: settles the pending confirmation. */
  confirmGate: { resolve(answer: boolean): void };
}

function setup(o: Options = {}): Setup {
  const context = o.context ?? POSIX_CONTEXT;
  const windows = context.windows ?? false;
  const calls: string[] = [];
  const confirmed: UriParts[] = [];
  const stated: UriParts[] = [];
  const previews: UriParts[] = [];
  const files: UriParts[] = [];
  let settle: ((answer: boolean) => void) | undefined;
  const confirmGate = { resolve: (answer: boolean): void => settle?.(answer) };
  const host: LinkHost = {
    pathContext: () => context,
    toUri: (ref) => fakeUri(ref, windows),
    confirm: (target) => {
      calls.push('confirm');
      confirmed.push(target);
      if (o.confirm === 'no') return Promise.resolve(false);
      if (o.confirm === 'reject') return Promise.reject(new Error('dialog failed'));
      if (o.confirm === 'gate') {
        return new Promise<boolean>((resolve) => {
          settle = resolve;
        });
      }
      return Promise.resolve(true);
    },
    stat: (target) => {
      calls.push('stat');
      stated.push(target);
      return o.statRejects ? Promise.reject(new Error('ENOENT')) : Promise.resolve();
    },
    warn: (message) => {
      calls.push(`warn:${message}`);
    },
    openPreview: (target) => {
      calls.push('openPreview');
      previews.push(target);
      if (o.openPreviewRejects) return Promise.reject(new Error('open failed'));
      return Promise.resolve({
        revealHeading: (slug: string) => {
          calls.push(`reveal:${slug}`);
        },
      });
    },
    openFile: (target) => {
      calls.push('openFile');
      files.push(target);
      return o.openFileRejects ? Promise.reject(new Error('open failed')) : Promise.resolve();
    },
    openExternal: (href) => {
      calls.push(`openExternal:${href}`);
      return o.openExternalRejects ? Promise.reject(new Error('no handler')) : Promise.resolve();
    },
    revealFragment: (_from, fragment) => {
      calls.push(`revealFragment:${fragment}`);
    },
  };
  return { opener: new LinkOpener(host), calls, confirmed, stated, previews, files, confirmGate };
}

/** Lets every already-resolved promise continuation run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('LinkOpener', () => {
  describe('targets outside the allowed roots', () => {
    it('confirms before the stat and the open, in that order', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, '../../outside.md');
      assert.deepEqual(s.calls, ['confirm', 'stat', 'openPreview']);
    });

    it('confirms before the stat and the open of a non-Markdown file', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, '../../outside.txt');
      assert.deepEqual(s.calls, ['confirm', 'stat', 'openFile']);
    });

    it('does nothing else when the user declines', async () => {
      const s = setup({ confirm: 'no' });
      await s.opener.open(POSIX_DOC, '../../outside.md');
      assert.deepEqual(s.calls, ['confirm']);
    });

    it('hands the target to the confirmation', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, '../../outside.md');
      assert.equal(s.confirmed.length, 1);
      assert.equal(s.confirmed[0].scheme, 'file');
      assert.equal(s.confirmed[0].path, '/outside.md');
      assert.equal(s.stated[0], s.confirmed[0]);
    });

    it('does not touch the file system while the confirmation is pending (UNC path)', async () => {
      const s = setup({ context: WIN_CONTEXT, confirm: 'gate' });
      const done = s.opener.open(WIN_DOC, '\\\\host\\share\\x.md');
      await flush();
      await flush();
      assert.deepEqual(s.calls, ['confirm'], 'only the confirmation may happen before it is answered');
      assert.equal(s.confirmed[0].authority, 'host');
      assert.equal(s.confirmed[0].path, '/share/x.md');
      s.confirmGate.resolve(true);
      await done;
      assert.deepEqual(s.calls, ['confirm', 'stat', 'openPreview']);
    });

    it('does not touch the UNC path at all when declined', async () => {
      const s = setup({ context: WIN_CONTEXT, confirm: 'gate' });
      const done = s.opener.open(WIN_DOC, '\\\\host\\share\\x.md');
      await flush();
      s.confirmGate.resolve(false);
      await done;
      assert.deepEqual(s.calls, ['confirm']);
    });

    it('treats a link climbing out of the workspace with .. as outside', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, '../../../etc/notes.txt');
      assert.deepEqual(s.calls, ['confirm', 'stat', 'openFile']);
    });

    it('propagates a failing confirmation and does nothing else', async () => {
      const s = setup({ confirm: 'reject' });
      await assert.rejects(s.opener.open(POSIX_DOC, '../../outside.md'), /dialog failed/);
      assert.deepEqual(s.calls, ['confirm']);
    });

    it('warns about a missing file after the confirmation', async () => {
      const s = setup({ statRejects: true });
      await s.opener.open(POSIX_DOC, '../../outside.md');
      assert.deepEqual(s.calls, ['confirm', 'stat', 'warn:Read Markdown: file not found: /outside.md']);
    });
  });

  describe('targets inside the allowed roots', () => {
    it('does not confirm', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, 'other.md');
      assert.deepEqual(s.calls, ['stat', 'openPreview']);
      assert.equal(s.previews[0].path, '/ws/docs/other.md');
    });

    it('does not confirm a link up to the workspace root', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, '../README.md');
      assert.deepEqual(s.calls, ['stat', 'openPreview']);
      assert.equal(s.previews[0].path, '/ws/README.md');
    });

    it('does not confirm a workspace-absolute link', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, '/docs/b.txt');
      assert.deepEqual(s.calls, ['stat', 'openFile']);
      assert.equal(s.files[0].path, '/ws/docs/b.txt');
    });

    it('warns once with the exact message and opens nothing for a missing file', async () => {
      const s = setup({ statRejects: true });
      await s.opener.open(POSIX_DOC, 'missing.md');
      assert.deepEqual(s.calls, ['stat', 'warn:Read Markdown: file not found: /ws/docs/missing.md']);
    });

    it('uses the fsPath of a Windows target in the missing file warning', async () => {
      const s = setup({ context: WIN_CONTEXT, statRejects: true });
      await s.opener.open(WIN_DOC, 'missing.md');
      assert.deepEqual(s.calls, ['stat', 'warn:Read Markdown: file not found: c:\\ws\\docs\\missing.md']);
    });

    it('does not reveal a heading of a file that is missing', async () => {
      const s = setup({ statRejects: true });
      await s.opener.open(POSIX_DOC, 'missing.md#intro');
      assert.ok(!s.calls.some((c) => c.startsWith('reveal') || c === 'openPreview'));
    });
  });

  describe('Markdown targets', () => {
    for (const name of ['a.md', 'a.markdown', 'a.mdown', 'a.mkd', 'a.mkdn', 'A.MD', 'a.Markdown']) {
      it(`opens ${name} in a preview`, async () => {
        const s = setup();
        await s.opener.open(POSIX_DOC, name);
        assert.deepEqual(s.calls, ['stat', 'openPreview']);
      });
    }

    for (const name of ['a.txt', 'a.png', 'LICENSE', 'notes.md.bak', 'a.mdx', 'md']) {
      it(`opens ${name} in an editor, not a preview`, async () => {
        const s = setup();
        await s.opener.open(POSIX_DOC, name);
        assert.deepEqual(s.calls, ['stat', 'openFile']);
        assert.equal(s.previews.length, 0);
      });
    }

    it('reveals the fragment in the opened preview, after opening it', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, 'other.md#intro');
      assert.deepEqual(s.calls, ['stat', 'openPreview', 'reveal:intro']);
    });

    it('reveals nothing without a fragment', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, 'other.md');
      assert.ok(!s.calls.some((c) => c.startsWith('reveal')));
      await s.opener.open(POSIX_DOC, 'other.md#');
      assert.ok(!s.calls.some((c) => c.startsWith('reveal')));
    });

    it('drops the query', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, 'other.md?x=1#intro');
      assert.equal(s.previews[0].path, '/ws/docs/other.md');
      assert.deepEqual(s.calls, ['stat', 'openPreview', 'reveal:intro']);
    });

    it('ignores the fragment of a non-Markdown target', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, 'a.txt#intro');
      assert.deepEqual(s.calls, ['stat', 'openFile']);
    });

    // The fragment is percent-decoded exactly once, by resolveReference.
    const fragments: [string, string][] = [
      ['a%2520b', 'a%20b'],
      ['100%25', '100%'],
      ['%E4%B8%AD', '中'],
      ['%E0%A4%A', '%E0%A4%A'],
      ['a%20b', 'a b'],
      ['plain', 'plain'],
    ];
    for (const [written, revealed] of fragments) {
      it(`reveals #${written} as ${JSON.stringify(revealed)}`, async () => {
        const s = setup();
        await s.opener.open(POSIX_DOC, `other.md#${written}`);
        assert.deepEqual(s.calls, ['stat', 'openPreview', `reveal:${revealed}`]);
      });
    }
  });

  describe('external links', () => {
    for (const href of ['https://example.com/a?b=1#c', 'http://example.com', 'mailto:me@example.com', 'HTTPS://EXAMPLE.COM']) {
      it(`hands ${href} to the OS as written and nothing else`, async () => {
        const s = setup();
        await s.opener.open(POSIX_DOC, href);
        assert.deepEqual(s.calls, [`openExternal:${href}`]);
      });
    }

    it('propagates a rejection of the OS handler', async () => {
      const s = setup({ openExternalRejects: true });
      await assert.rejects(s.opener.open(POSIX_DOC, 'https://example.com'), /no handler/);
      assert.deepEqual(s.calls, ['openExternal:https://example.com']);
    });
  });

  describe('ignored links', () => {
    for (const href of ['command:workbench.action.quit', 'vscode:extension/x', 'javascript:alert(1)', 'C:/x.md', 'data:text/html,x', '']) {
      it(`makes no call for ${JSON.stringify(href)}`, async () => {
        const s = setup();
        await s.opener.open(POSIX_DOC, href);
        assert.deepEqual(s.calls, []);
      });
    }

    it('makes no call for a drive path on a Windows host either', async () => {
      const s = setup({ context: WIN_CONTEXT });
      await s.opener.open(WIN_DOC, 'C:/x.md');
      assert.deepEqual(s.calls, []);
    });
  });

  describe('fragment links', () => {
    it('reveals the heading in the document and does nothing else', async () => {
      const s = setup();
      await s.opener.open(POSIX_DOC, '#my-heading');
      assert.deepEqual(s.calls, ['revealFragment:my-heading']);
    });

    for (const [written, revealed] of [
      ['a%2520b', 'a%20b'],
      ['100%25', '100%'],
      ['%E4%B8%AD', '中'],
      ['%E0%A4%A', '%E0%A4%A'],
    ]) {
      it(`reveals #${written} as ${JSON.stringify(revealed)}`, async () => {
        const s = setup();
        await s.opener.open(POSIX_DOC, `#${written}`);
        assert.deepEqual(s.calls, [`revealFragment:${revealed}`]);
      });
    }
  });

  describe('errors from the ports', () => {
    it('propagates a failing preview open (no reveal)', async () => {
      const s = setup({ openPreviewRejects: true });
      await assert.rejects(s.opener.open(POSIX_DOC, 'other.md#x'), /open failed/);
      assert.deepEqual(s.calls, ['stat', 'openPreview']);
    });

    it('propagates a failing editor open', async () => {
      const s = setup({ openFileRejects: true });
      await assert.rejects(s.opener.open(POSIX_DOC, 'a.txt'), /open failed/);
      assert.deepEqual(s.calls, ['stat', 'openFile']);
    });

    it('treats any failing stat as a missing file', async () => {
      const s = setup({ statRejects: true });
      await s.opener.open(POSIX_DOC, 'a.txt');
      assert.deepEqual(s.calls, ['stat', 'warn:Read Markdown: file not found: /ws/docs/a.txt']);
    });
  });
});

describe('outsideTargetPrompt', () => {
  it('shows the fsPath of a file target', () => {
    const p = outsideTargetPrompt(fakeUri({ scheme: 'file', authority: 'host', path: '/share/x.md' }, true));
    assert.equal(p.message, 'This link opens a file outside the workspace.');
    assert.equal(p.detail, 'The link points to:\n\\\\host\\share\\x.md');
    assert.equal(p.accept, 'Open');
  });

  it('shows the URI of any other target', () => {
    const p = outsideTargetPrompt({
      scheme: 'vscode-remote',
      authority: 'ssh-remote+box',
      path: '/x.md',
      fsPath: '/x.md',
      toString: (skipEncoding?: boolean) => `vscode-remote://ssh-remote+box/x.md#${String(skipEncoding)}`,
    } as unknown as vscode.Uri);
    assert.equal(p.detail, 'The link points to:\nvscode-remote://ssh-remote+box/x.md#true');
  });
});
