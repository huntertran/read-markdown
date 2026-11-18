import * as assert from 'node:assert/strict';
import { resolveRawHtmlResources as resolve } from '../../src/render/rawHtmlResources';

/** Resolves every URL that does not start with `https:`. */
const toWebview = (url: string): string | undefined => (url.startsWith('https:') ? undefined : `https://wv/${url}`);

describe('resolveRawHtmlResources', () => {
  it('rewrites src of img, source, video, audio and track, in any quoting', () => {
    assert.equal(resolve('<img src="a.png" alt="x">', toWebview), '<img src="https://wv/a.png" alt="x">');
    assert.equal(resolve("<IMG SRC='a.png'/>", toWebview), '<IMG SRC="https://wv/a.png"/>');
    assert.equal(resolve('<img src=a.png width=40>', toWebview), '<img src="https://wv/a.png" width=40>');
    assert.equal(
      resolve('<video poster="p.jpg" controls>\n  <source src="v.mp4">\n  <track src="t.vtt">\n</video><audio src="s.mp3"></audio>', toWebview),
      '<video poster="https://wv/p.jpg" controls>\n  <source src="https://wv/v.mp4">\n  <track src="https://wv/t.vtt">\n</video><audio src="https://wv/s.mp3"></audio>',
    );
  });

  it('rewrites each srcset candidate and keeps its descriptor', () => {
    assert.equal(
      resolve('<picture><source srcset="a.png 1x, https://x.test/b.png 2x"><img srcset="c.png 100w,d.png 200w"></picture>', toWebview),
      '<picture><source srcset="https://wv/a.png 1x, https://x.test/b.png 2x"><img srcset="https://wv/c.png 100w,https://wv/d.png 200w"></picture>',
    );
  });

  it('decodes character references before resolving and escapes the result', () => {
    const seen: string[] = [];
    const out = resolve('<img src="a&amp;b&#32;c.png">', (url) => {
      seen.push(url);
      return `https://wv/${url}?"q"`;
    });
    assert.deepEqual(seen, ['a&b c.png']);
    assert.equal(out, '<img src="https://wv/a&amp;b c.png?&quot;q&quot;">');
  });

  it('leaves values the resolver keeps, other tags and other attributes alone', () => {
    for (const html of [
      '<img src="https://x.test/a.png">',
      '<img alt="src=a.png">',
      '<img data-src="a.png">',
      '<a href="a.png">a</a>',
      '<iframe src="a.html"></iframe>',
      '<div>no media</div>',
      '<img src>',
    ]) {
      assert.equal(resolve(html, toWebview), html);
    }
  });

  it('does not change the line count of a block', () => {
    const html = '<p align="center">\n  <img\n    src="a.png"\n    width="200">\n</p>\n';
    const out = resolve(html, toWebview);
    assert.equal(out, '<p align="center">\n  <img\n    src="https://wv/a.png"\n    width="200">\n</p>\n');
  });
});
