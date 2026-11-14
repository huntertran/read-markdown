import * as assert from 'node:assert/strict';
import { buildCsp } from '../../src/preview/csp';

const cspSource = 'https://file+.vscode-resource.vscode-cdn.net';
const nonce = 'abc123==';

/** The sources of each directive, split like a browser would. */
function parse(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

describe('buildCsp', () => {
  for (const allowRemoteContent of [true, false]) {
    describe(`allowRemoteContent: ${allowRemoteContent}`, () => {
      const policy = parse(buildCsp({ cspSource, nonce, allowRemoteContent }));

      it('denies everything by default', () => {
        assert.deepEqual(policy.get('default-src'), [`'none'`]);
      });

      it('never allows remote stylesheets or fonts', () => {
        for (const d of ['style-src', 'font-src']) {
          const sources = policy.get(d) ?? [];
          assert.ok(!sources.includes('https:'), `${d} has https:`);
          assert.ok(!sources.some((s) => s === 'http:' || s === '*'), `${d} has a wildcard`);
        }
      });

      it('keeps the extension origin and inline styles working', () => {
        assert.deepEqual(policy.get('style-src'), [cspSource, `'unsafe-inline'`]);
        assert.ok(policy.get('font-src')?.includes(cspSource));
        assert.ok(policy.get('img-src')?.includes(cspSource));
        assert.ok(policy.get('img-src')?.includes('data:'));
        assert.ok(policy.get('img-src')?.includes('blob:'));
        assert.ok(policy.get('media-src')?.includes(cspSource));
      });

      it('only runs the nonced script', () => {
        assert.deepEqual(policy.get('script-src'), [`'nonce-${nonce}'`]);
      });

      it('keeps the other restrictions', () => {
        assert.deepEqual(policy.get('form-action'), [`'none'`]);
        assert.deepEqual(policy.get('base-uri'), [`'none'`]);
        assert.deepEqual([...policy.keys()].sort(), [
          'base-uri', 'default-src', 'font-src', 'form-action', 'img-src', 'media-src', 'script-src', 'style-src',
        ]);
      });
    });
  }

  it('allows https: images and media only when remote content is allowed', () => {
    const on = parse(buildCsp({ cspSource, nonce, allowRemoteContent: true }));
    const off = parse(buildCsp({ cspSource, nonce, allowRemoteContent: false }));
    for (const d of ['img-src', 'media-src']) {
      assert.ok(on.get(d)?.includes('https:'), `${d} (on)`);
      assert.ok(!off.get(d)?.includes('https:'), `${d} (off)`);
    }
  });

  it('has no remote scheme source anywhere when remote content is off', () => {
    const policy = parse(buildCsp({ cspSource, nonce, allowRemoteContent: false }));
    for (const [d, sources] of policy) {
      for (const s of sources) {
        assert.ok(s !== 'https:' && s !== 'http:' && s !== '*' && s !== 'ws:' && s !== 'wss:', `${d} allows ${s}`);
      }
    }
  });
});
