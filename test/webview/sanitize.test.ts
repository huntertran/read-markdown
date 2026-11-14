import * as assert from 'node:assert/strict';
import { sanitize } from '../../webview/sanitize';
import { useDom } from './dom';

/** Sanitizes `html` and returns the result as a fragment. */
const clean = (html: string) => sanitize(html);
/** First element matching `selector`; fails the test when missing. */
function one(frag: DocumentFragment, selector: string): Element {
  const el = frag.querySelector(selector);
  assert.ok(el, `expected <${selector}> in the result`);
  return el;
}

describe('sanitize', () => {
  useDom();

  describe('active content is removed', () => {
    for (const tag of ['script', 'iframe', 'frame', 'object', 'embed', 'applet', 'base', 'meta', 'link', 'form', 'noscript']) {
      it(`removes <${tag}>`, () => {
        const frag = clean(`<p>keep</p><${tag} src="x" href="x"></${tag}><p>also keep</p>`);
        assert.equal(frag.querySelectorAll(tag).length, 0);
        assert.equal(frag.querySelectorAll('p').length, 2);
      });
    }

    it('removes <frameset>', () => {
      // Inside a <template> the parser may drop <frameset> itself; either way nothing survives.
      const frag = clean('<p>keep</p><frameset><frame src="x"></frameset>');
      assert.equal(frag.querySelectorAll('frameset, frame').length, 0);
      assert.equal(frag.querySelectorAll('p').length, 1);
    });

    it('removes scripts with their content and nested inside other elements', () => {
      const frag = clean('<div><p>a<script>alert(1)</script>b</p></div>');
      assert.equal(frag.querySelectorAll('script').length, 0);
      assert.equal(one(frag, 'p').textContent, 'ab');
    });

    it('removes an iframe nested in a block and keeps its siblings', () => {
      const frag = clean('<blockquote><iframe src="https://example.com"></iframe><p>text</p></blockquote>');
      assert.equal(frag.querySelectorAll('iframe').length, 0);
      assert.equal(one(frag, 'blockquote > p').textContent, 'text');
    });

    it('removes <script> inside inline SVG', () => {
      const frag = clean('<svg><circle r="1"></circle><script>alert(1)</script></svg>');
      assert.equal(frag.querySelectorAll('script').length, 0);
      assert.equal(frag.querySelectorAll('circle').length, 1);
    });
  });

  describe('event handler attributes are removed', () => {
    it('removes onclick', () => {
      const a = one(clean('<a href="https://example.com" onclick="alert(1)">x</a>'), 'a');
      assert.equal(a.hasAttribute('onclick'), false);
      assert.equal(a.getAttribute('href'), 'https://example.com');
    });

    it('removes onerror on images but keeps src', () => {
      const img = one(clean('<img src="a.png" onerror="alert(1)">'), 'img');
      assert.equal(img.hasAttribute('onerror'), false);
      assert.equal(img.getAttribute('src'), 'a.png');
    });

    it('removes mixed-case handlers', () => {
      const p = one(clean('<p OnMouseOver="x()" ONCLICK="y()" onLoad="z()">t</p>'), 'p');
      assert.deepEqual(
        [...p.attributes].map((a) => a.name),
        [],
      );
    });

    it('removes handlers on SVG elements', () => {
      const frag = clean('<svg onload="alert(1)"><rect onclick="x()"></rect></svg>');
      assert.equal(one(frag, 'svg').hasAttribute('onload'), false);
      assert.equal(one(frag, 'rect').hasAttribute('onclick'), false);
    });

    it('removes handlers on every element of a deep tree', () => {
      const frag = clean('<div onclick="a()"><ul><li onfocus="b()"><span onmouseenter="c()">x</span></li></ul></div>');
      for (const el of frag.querySelectorAll('*')) {
        assert.deepEqual(
          [...el.attributes].filter((a) => a.name.toLowerCase().startsWith('on')),
          [],
        );
      }
    });
  });

  describe('script URLs are neutralized', () => {
    const cases: [string, string][] = [
      ['javascript: in href', '<a href="javascript:alert(1)">x</a>'],
      ['uppercase JAVASCRIPT:', '<a href="JAVASCRIPT:alert(1)">x</a>'],
      ['mixed-case JaVaScRiPt:', '<a href="JaVaScRiPt:alert(1)">x</a>'],
      ['leading spaces', '<a href="   javascript:alert(1)">x</a>'],
      ['leading newline and tab', '<a href="&#10;&#9;javascript:alert(1)">x</a>'],
      ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>'],
      ['data:text/html', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
      ['uppercase DATA:TEXT/HTML', '<a href="DATA:TEXT/HTML;base64,PHNjcmlwdD4=">x</a>'],
    ];
    for (const [name, html] of cases) {
      it(`removes href: ${name}`, () => {
        assert.equal(one(clean(html), 'a').hasAttribute('href'), false);
      });
    }

    it('removes javascript: in img src, video poster and formaction', () => {
      assert.equal(one(clean('<img src="javascript:alert(1)">'), 'img').hasAttribute('src'), false);
      assert.equal(one(clean('<video poster="javascript:alert(1)"></video>'), 'video').hasAttribute('poster'), false);
      assert.equal(one(clean('<button formaction="javascript:alert(1)">x</button>'), 'button').hasAttribute('formaction'), false);
      assert.equal(one(clean('<input formaction="javascript:alert(1)">'), 'input').hasAttribute('formaction'), false);
    });

    it('removes javascript: in xlink:href on SVG anchors', () => {
      const a = one(clean('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'), 'a');
      assert.equal(a.hasAttribute('xlink:href'), false);
    });

    it('removes javascript: in href on SVG anchors and <area>', () => {
      assert.equal(one(clean('<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'), 'a').hasAttribute('href'), false);
      assert.equal(one(clean('<map><area href="javascript:alert(1)" shape="default"></map>'), 'area').hasAttribute('href'), false);
    });

    it('removes a javascript: URL placed in srcset when it comes first', () => {
      assert.equal(one(clean('<img srcset="javascript:alert(1) 1x">'), 'img').hasAttribute('srcset'), false);
    });
  });

  describe('data-vscode-context', () => {
    it('strips an author-supplied data-vscode-context from any element', () => {
      const frag = clean('<div data-vscode-context="{&quot;webviewSection&quot;:&quot;rm-block&quot;}"><p data-vscode-context="{}">x</p></div>');
      assert.equal(frag.querySelectorAll('[data-vscode-context]').length, 0);
      assert.equal(frag.querySelectorAll('div, p').length, 2);
    });

    it('strips it regardless of attribute case', () => {
      assert.equal(clean('<p DATA-VSCODE-CONTEXT="{}">x</p>').querySelectorAll('[data-vscode-context]').length, 0);
    });
  });

  describe('benign content is preserved', () => {
    it('keeps headings, paragraphs and inline formatting', () => {
      const frag = clean('<h1 id="t">Title</h1><h2>Sub</h2><p>a <strong>b</strong> <em>c</em> <code>d</code></p>');
      assert.equal(one(frag, 'h1').textContent, 'Title');
      assert.equal(frag.querySelectorAll('h2, strong, em, code').length, 4);
    });

    it('keeps http, https, mailto, relative and anchor hrefs', () => {
      const hrefs = ['http://example.com/a?b=c', 'https://example.com', 'mailto:me@example.com', './doc.md', '../up/other.md#sec', '#anchor', '/abs/path'];
      const frag = clean(hrefs.map((h) => `<a href="${h}">l</a>`).join(''));
      assert.deepEqual(
        [...frag.querySelectorAll('a')].map((a) => a.getAttribute('href')),
        hrefs,
      );
    });

    it('keeps images with relative, https and data:image sources', () => {
      const srcs = ['pics/a.png', 'https://example.com/a.png', 'data:image/png;base64,AAAA'];
      const frag = clean(srcs.map((s) => `<img src="${s}" alt="a">`).join(''));
      assert.deepEqual(
        [...frag.querySelectorAll('img')].map((i) => i.getAttribute('src')),
        srcs,
      );
      assert.equal(one(frag, 'img').getAttribute('alt'), 'a');
    });

    it('keeps srcset with plain URLs', () => {
      assert.equal(one(clean('<img src="a.png" srcset="a.png 1x, b.png 2x">'), 'img').getAttribute('srcset'), 'a.png 1x, b.png 2x');
    });

    it('keeps tables', () => {
      const frag = clean('<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>');
      assert.equal(frag.querySelectorAll('table > thead > tr > th').length, 1);
      assert.equal(one(frag, 'table > tbody > tr > td').textContent, '1');
    });

    it('keeps code blocks with highlight.js spans', () => {
      const frag = clean('<pre class="rm-code"><code class="hljs language-ts" data-lang="ts"><span class="hljs-keyword">const</span> x</code></pre>');
      assert.equal(one(frag, 'pre.rm-code > code.hljs > span.hljs-keyword').textContent, 'const');
      assert.equal(one(frag, 'code').getAttribute('data-lang'), 'ts');
    });

    it('keeps the renderer attributes', () => {
      const frag = clean(
        '<h2 id="intro" class="x" data-line="3" data-line-end="4">Intro</h2>' +
          '<ul data-line="5" data-line-end="7"><li data-line="5" data-item-end="6" data-task="active"><input type="checkbox" disabled>t</li></ul>' +
          '<a href="a.md" data-href="a.md">a</a><pre data-lang="mermaid"></pre>',
      );
      const h = one(frag, 'h2');
      assert.equal(h.id, 'intro');
      assert.equal(h.className, 'x');
      assert.equal(h.getAttribute('data-line'), '3');
      assert.equal(h.getAttribute('data-line-end'), '4');
      const li = one(frag, 'li');
      assert.equal(li.getAttribute('data-item-end'), '6');
      assert.equal(li.getAttribute('data-task'), 'active');
      assert.equal(one(frag, 'input').getAttribute('type'), 'checkbox');
      assert.equal(one(frag, 'a').getAttribute('data-href'), 'a.md');
      assert.equal(one(frag, 'pre').getAttribute('data-lang'), 'mermaid');
    });

    it('keeps <style> elements and style attributes (project decision)', () => {
      const frag = clean('<style>.x { color: red }</style><p style="color: blue">t</p>');
      assert.equal(one(frag, 'style').textContent, '.x { color: red }');
      assert.equal(one(frag, 'p').getAttribute('style'), 'color: blue');
    });

    it('keeps attributes that merely contain "on" later in the name or value', () => {
      const el = one(clean('<p data-on="1" aria-description="d" title="on top">t</p>'), 'p');
      assert.equal(el.getAttribute('data-on'), '1');
      assert.equal(el.getAttribute('title'), 'on top');
    });

    it('keeps plain inline SVG shapes', () => {
      const frag = clean('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"></circle></svg>');
      assert.equal(one(frag, 'svg').getAttribute('viewBox'), '0 0 10 10');
      assert.equal(one(frag, 'circle').getAttribute('fill'), 'red');
    });

    it('keeps escaped text content', () => {
      assert.equal(one(clean('<p>1 &lt; 2 &amp; 3</p>'), 'p').textContent, '1 < 2 & 3');
    });

    it('returns an empty fragment for empty input', () => {
      assert.equal(clean('').childNodes.length, 0);
    });
  });

  // Known gaps (clean-code review S7): these state the DESIRED behaviour, so they stay pending
  // until the sanitizer is rewritten as an allowlist.
  describe('known gaps (pending until S7)', () => {
    it.skip('removes javascript: with a tab inside the scheme (S7)', () => {
      const a = one(clean('<a href="java&#9;script:alert(1)">x</a>'), 'a');
      assert.equal(a.hasAttribute('href'), false);
    });

    it.skip('removes javascript: with a newline inside the scheme (S7)', () => {
      const a = one(clean('<a href="java&#10;script:alert(1)">x</a>'), 'a');
      assert.equal(a.hasAttribute('href'), false);
    });

    it.skip('removes a javascript: URL in the second srcset candidate (S7)', () => {
      const img = one(clean('<img srcset="a.png 1x, javascript:alert(1) 2x">'), 'img');
      assert.equal(img.hasAttribute('srcset'), false);
    });

    it.skip('removes SVG <use> pointing at an external document (S7)', () => {
      const frag = clean('<svg><use href="data:image/svg+xml;base64,AAAA#x"></use></svg>');
      assert.equal(frag.querySelectorAll('use').length, 0);
    });

    it.skip('removes SVG <animate> that can set a script URL (S7)', () => {
      const frag = clean('<svg><a><animate attributeName="href" values="javascript:alert(1)"></animate><text>x</text></a></svg>');
      assert.equal(frag.querySelectorAll('animate').length, 0);
    });

    it.skip('removes SVG <foreignObject> (S7)', () => {
      const frag = clean('<svg><foreignObject><div>html</div></foreignObject></svg>');
      assert.equal(frag.querySelectorAll('foreignObject').length, 0);
    });
  });
});
