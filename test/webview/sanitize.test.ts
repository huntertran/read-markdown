import * as assert from 'node:assert/strict';
import { createMarkdownRenderer } from '../../src/render/markdown';
import { sanitize } from '../../webview/sanitize';
import { useDom } from './dom';

/** Sanitizes `html` and returns the result as a fragment. */
const clean = (html: string) => sanitize(html);
/** Serializable wrapper around a fragment (a fragment has no innerHTML of its own). */
function wrap(frag: DocumentFragment): HTMLElement {
  const div = document.createElement('div');
  div.append(frag.cloneNode(true));
  return div;
}
const render = createMarkdownRenderer();
/** Renders Markdown with the real renderer, as the extension host does. */
const renderMarkdown = (md: string) =>
  render(md, { mermaid: true, resolveResource: (p) => `https://file%2B.vscode-resource.vscode-cdn.net/d%3A/docs/${p}` }).html;
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

    it('removes javascript: in img src and video poster', () => {
      assert.equal(one(clean('<img src="javascript:alert(1)">'), 'img').hasAttribute('src'), false);
      assert.equal(one(clean('<video poster="javascript:alert(1)"></video>'), 'video').hasAttribute('poster'), false);
    });

    // Allowlist: form controls are not allowed at all, so `formaction` can never reach the DOM.
    // (Previously the elements stayed and only the attribute was dropped.)
    it('drops <button> (keeping its text) and non-checkbox <input>, so formaction cannot survive', () => {
      const frag = clean('<button formaction="javascript:alert(1)">x</button><input formaction="javascript:alert(1)"><input type="text" value="v">');
      assert.equal(frag.querySelectorAll('button, input, [formaction]').length, 0);
      assert.equal(frag.textContent, 'x');
    });

    it('removes javascript: in xlink:href on SVG anchors', () => {
      const a = one(clean('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'), 'a');
      assert.equal(a.hasAttribute('xlink:href'), false);
    });

    it('removes javascript: in href on SVG anchors', () => {
      assert.equal(one(clean('<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'), 'a').hasAttribute('href'), false);
    });

    // Allowlist: image maps are not allowed (previously <area> stayed with its href dropped).
    it('drops <map> and <area> together with their script URLs', () => {
      const frag = clean('<map name="m"><area href="javascript:alert(1)" shape="default"></map><area href="https://example.com">');
      assert.equal(frag.querySelectorAll('map, area, [href]').length, 0);
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
      const el = one(clean('<p aria-description="d" title="on top">t</p>'), 'p');
      assert.equal(el.getAttribute('aria-description'), 'd');
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

  // Gaps the old blocklist had (clean-code review S7); the allowlist closes them.
  describe('former blocklist gaps (S7)', () => {
    it('removes javascript: with a tab inside the scheme', () => {
      const a = one(clean('<a href="java&#9;script:alert(1)">x</a>'), 'a');
      assert.equal(a.hasAttribute('href'), false);
    });

    it('removes javascript: with a newline inside the scheme', () => {
      const a = one(clean('<a href="java&#10;script:alert(1)">x</a>'), 'a');
      assert.equal(a.hasAttribute('href'), false);
    });

    it('removes a javascript: URL in the second srcset candidate', () => {
      const img = one(clean('<img srcset="a.png 1x, javascript:alert(1) 2x">'), 'img');
      assert.equal(img.hasAttribute('srcset'), false);
    });

    it('removes SVG <use> pointing at an external document', () => {
      const frag = clean('<svg><use href="data:image/svg+xml;base64,AAAA#x"></use></svg>');
      assert.equal(frag.querySelectorAll('use').length, 0);
    });

    it('removes SVG <animate> that can set a script URL', () => {
      const frag = clean('<svg><a><animate attributeName="href" values="javascript:alert(1)"></animate><text>x</text></a></svg>');
      assert.equal(frag.querySelectorAll('animate').length, 0);
    });

    it('removes SVG <foreignObject> (with its content)', () => {
      const frag = clean('<svg><foreignObject><div>html</div></foreignObject></svg>');
      assert.equal(frag.querySelectorAll('foreignObject').length, 0);
      assert.equal(frag.textContent, '');
    });
  });

  describe('script URL variants', () => {
    const hrefCases: [string, string][] = [
      ['entity-encoded scheme (&#106;avascript:)', '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>'],
      ['entity without semicolon', '<a href="&#106avascript:alert(1)">x</a>'],
      ['named colon entity', '<a href="javascript&colon;alert(1)">x</a>'],
      ['mixed case with embedded tab and newline', '<a href="JaVa&#9;Sc&#10;RiPt:alert(1)">x</a>'],
      ['leading control characters', '<a href="&#1;&#2;javascript:alert(1)">x</a>'],
      ['carriage return inside the scheme', '<a href="java&#13;script:alert(1)">x</a>'],
      ['data:text/html with a leading space', '<a href="  data:text/html;base64,PHNjcmlwdD4=">x</a>'],
      ['data:image on a link (data: is only for media sources)', '<a href="data:image/svg+xml;base64,AAAA">x</a>'],
      ['file:', '<a href="file:///etc/passwd">x</a>'],
      ['unknown scheme', '<a href="vscode://x/y">x</a>'],
    ];
    for (const [name, html] of hrefCases) {
      it(`removes href: ${name}`, () => {
        assert.equal(one(clean(html), 'a').hasAttribute('href'), false);
      });
    }

    it('removes the whole srcset when any candidate is unsafe, whatever the order or spacing', () => {
      for (const srcset of [
        'a.png 1x,javascript:alert(1) 2x',
        'a.png 1x, JaVaScRiPt:alert(1) 2x',
        'a.png 1x, b.png 2x, vbscript:x 3x',
        'a.png 1x, data:text/html;base64,AAAA 2x',
      ]) {
        assert.equal(one(clean(`<img srcset="${srcset}">`), 'img').hasAttribute('srcset'), false, srcset);
      }
    });

    it('checks every <source srcset> candidate inside <picture>', () => {
      const frag = clean('<picture><source srcset="a.webp 1x, javascript:x 2x" type="image/webp"><img src="a.png" alt="a"></picture>');
      assert.equal(one(frag, 'source').hasAttribute('srcset'), false);
      assert.equal(one(frag, 'source').getAttribute('type'), 'image/webp');
      assert.equal(one(frag, 'img').getAttribute('src'), 'a.png');
    });

    it('keeps srcset with density and width descriptors, https and relative URLs', () => {
      const img = one(clean('<img src="a.png" srcset="https://example.com/a.png 1x, ./b.png 2x, c.png 480w" sizes="(max-width: 600px) 480px, 800px">'), 'img');
      assert.equal(img.getAttribute('srcset'), 'https://example.com/a.png 1x, ./b.png 2x, c.png 480w');
      assert.equal(img.getAttribute('sizes'), '(max-width: 600px) 480px, 800px');
    });

    it('keeps data:image sources only on media elements', () => {
      const frag = clean('<img src="data:image/png;base64,AAAA"><a href="data:image/png;base64,AAAA">x</a>');
      assert.equal(one(frag, 'img').getAttribute('src'), 'data:image/png;base64,AAAA');
      assert.equal(one(frag, 'a').hasAttribute('href'), false);
    });

    it('keeps the webview resource URLs the host produces for relative images', () => {
      const src = 'https://file%2B.vscode-resource.vscode-cdn.net/d%3A/docs/pics/a.png';
      assert.equal(one(clean(`<img src="${src}" alt="a">`), 'img').getAttribute('src'), src);
    });

    it('removes javascript: from other URL-bearing attributes', () => {
      const frag = clean('<blockquote cite="javascript:alert(1)">q</blockquote><video src="javascript:alert(1)" poster="vbscript:x"></video><source src="javascript:x">');
      assert.equal(frag.querySelectorAll('[cite], [src], [poster]').length, 0);
    });
  });

  describe('allowlist behaviour', () => {
    it('unwraps unknown and custom elements, keeping their content', () => {
      const frag = clean('<p>a <custom-el data-x="1">b <em>c</em></custom-el> <blink>d</blink><marquee>e</marquee></p>');
      assert.equal(frag.querySelectorAll('custom-el, blink, marquee').length, 0);
      assert.equal(one(frag, 'p').textContent, 'a b c de');
      assert.equal(frag.querySelectorAll('p > em').length, 1);
    });

    it('drops <math> and <template> with their content', () => {
      const frag = clean('<p>x</p><math><mi>y</mi></math><template><b>t</b></template>');
      assert.equal(frag.querySelectorAll('math, mi, template, b').length, 0);
      assert.equal(frag.textContent, 'x');
    });

    it('removes <form> with its content, as the old sanitizer did', () => {
      const frag = clean('<p>keep</p><form action="x"><p>inner</p><input type="text"></form>');
      assert.equal(frag.querySelectorAll('form, input').length, 0);
      assert.equal(frag.textContent, 'keep');
    });

    it('drops <button> and <select> as elements but keeps their text', () => {
      const frag = clean('<button>go</button><select><option>o</option></select>');
      assert.equal(frag.querySelectorAll('button, select, option').length, 0);
      assert.match(frag.textContent ?? '', /go/);
    });

    it('drops attributes that are not on the list (target, contenteditable, slot, tabindex, ping)', () => {
      const a = one(clean('<a href="https://example.com" target="_blank" contenteditable="true" slot="s" tabindex="0" ping="https://x" autofocus>x</a>'), 'a');
      assert.deepEqual(
        [...a.attributes].map((at) => at.name),
        ['href'],
      );
    });

    it('removes an element that carries an is="" attribute (customized built-ins)', () => {
      const frag = clean('<p>a</p><button is="x-y">b</button><p is="x-z">c</p>');
      assert.equal(frag.querySelectorAll('[is]').length, 0);
      assert.equal(frag.querySelectorAll('p').length >= 1, true);
    });

    it('drops unknown data-* attributes but keeps aria-* and role', () => {
      const el = one(clean('<p data-move-id="1" data-rm-config="x" data-slug="s" data-custom="c" aria-label="l" aria-hidden="true" role="note">t</p>'), 'p');
      assert.deepEqual(
        [...el.attributes].map((at) => at.name).sort(),
        ['aria-hidden', 'aria-label', 'role'],
      );
    });

    it('drops comments and processing instructions', () => {
      const frag = clean('<p>a</p><!-- note --><?php echo 1 ?><p>b</p>');
      assert.equal(frag.querySelectorAll('p').length, 2);
      assert.doesNotMatch(wrap(frag).innerHTML, /note|php/);
    });

    it('does not touch the live document', () => {
      const before = document.body.innerHTML;
      clean('<p onclick="x()">a</p><img src="x.png">');
      assert.equal(document.body.innerHTML, before);
    });

    it('does not let an unsafe element come back through nested or malformed markup', () => {
      for (const html of [
        '<scr<script>ipt>alert(1)</scr</script>ipt>',
        '<svg><style><img src=x onerror=alert(1)></style></svg>',
        '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
        '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
        '<a href="x"><svg></a><img src=x onerror=alert(1)>',
        '<img src="x" onerror=alert(1) / onload=alert(2)>',
        '<p/onclick=alert(1)>x</p>',
      ]) {
        const frag = clean(html);
        assert.equal(frag.querySelectorAll('script').length, 0, html);
        for (const el of frag.querySelectorAll('*')) {
          assert.deepEqual(
            [...el.attributes].filter((at) => at.name.startsWith('on')),
            [],
            html,
          );
        }
      }
    });
  });

  describe('<style> (kept on purpose)', () => {
    it('keeps a <style> at the very top of the document', () => {
      const frag = clean('<style>h1 { color: red }</style>\n<h1>Title</h1>');
      assert.equal(one(frag, 'style').textContent, 'h1 { color: red }');
      assert.equal(one(frag, 'h1').textContent, 'Title');
      assert.equal(frag.firstElementChild?.tagName, 'STYLE');
    });

    it('keeps a <style> in the middle of the document', () => {
      const frag = clean('<p>before</p><style>p { margin: 0 }</style><p>after</p>');
      assert.deepEqual(
        [...frag.children].map((c) => c.tagName),
        ['P', 'STYLE', 'P'],
      );
      assert.equal(one(frag, 'style').textContent, 'p { margin: 0 }');
    });

    it('keeps the CSS text intact with child selectors, @media and quoted strings', () => {
      const css = '.a > .b + .c ~ .d { color: red }\n@media (min-width: 600px) and (prefers-color-scheme: dark) {\n  .a > p[title="a > b"] { content: "x > y"; margin: 0 }\n}\n@import url("https://example.com/x.css");';
      const frag = clean(`<style>${css}</style><p class="a">x</p>`);
      assert.equal(one(frag, 'style').textContent, css);
    });

    it('keeps several <style> elements and their order', () => {
      const frag = clean('<style>a{color:red}</style><p>x</p><style media="print">b{display:none}</style>');
      const styles = [...frag.querySelectorAll('style')];
      assert.deepEqual(
        styles.map((st) => st.textContent),
        ['a{color:red}', 'b{display:none}'],
      );
      assert.equal(styles[1]?.getAttribute('media'), 'print');
    });

    it('keeps style attributes on any element, including SVG', () => {
      const frag = clean('<div style="display:flex;gap:4px">x</div><svg><rect style="fill:red" width="1" height="1"></rect></svg>');
      assert.equal(one(frag, 'div').getAttribute('style'), 'display:flex;gap:4px');
      assert.equal(one(frag, 'rect').getAttribute('style'), 'fill:red');
    });

    it('drops a <style> whose CSS text contains markup ("<" followed by a letter)', () => {
      // DOMPurify removes such a <style> as a whole: a known limitation, not a project choice.
      const frag = clean('<style>.x{color:red}</style><style>a[href="<b>"]{color:red}</style><p>x</p>');
      assert.equal(frag.querySelectorAll('style').length, 1);
      assert.equal(one(frag, 'style').textContent, '.x{color:red}');
    });
  });

  describe('renderer output passes through unchanged', () => {
    it('keeps every renderer attribute, including nested ones', () => {
      const frag = clean(
        '<details class="rm-frontmatter" data-line="0" data-line-end="3"><summary>Front matter</summary><pre class="rm-code"><code class="hljs language-yaml">a: 1</code></pre></details>' +
          '<ul class="contains-task-list" data-line="4" data-line-end="6">' +
          '<li class="task-list-item" data-line="4" data-item-end="5" data-task="active"><label><input class="task-list-item-checkbox" disabled="" type="checkbox"> step</label></li>' +
          '<li class="task-list-item" data-line="5" data-item-end="6"><label><input class="task-list-item-checkbox" disabled="" type="checkbox" checked=""> done</label></li></ul>' +
          '<blockquote class="rm-alert rm-alert-note" data-line="7" data-line-end="9"><p data-line="7"><span class="rm-alert-title">Note</span>text</p></blockquote>' +
          '<div class="rm-mermaid" data-line="10" data-line-end="14"><pre class="mermaid">graph TD; A--&gt;B</pre></div>' +
          '<pre class="rm-code" data-line="15" data-line-end="18" data-lang="ts"><code class="hljs language-ts"><span class="hljs-keyword">let</span> x</code></pre>' +
          '<p data-line="19" data-line-end="20"><a href="doc.md" data-href="doc.md">doc</a></p>',
      );
      const attrs = (sel: string) => [...one(frag, sel).attributes].map((at) => `${at.name}=${at.value}`).sort();
      const eq = (sel: string, expected: string[]) => assert.deepEqual(attrs(sel), [...expected].sort());
      eq('details', ['class=rm-frontmatter', 'data-line=0', 'data-line-end=3']);
      eq('li[data-task]', ['class=task-list-item', 'data-item-end=5', 'data-line=4', 'data-task=active']);
      eq('input', ['class=task-list-item-checkbox', 'disabled=', 'type=checkbox']);
      eq('input[checked]', ['checked=', 'class=task-list-item-checkbox', 'disabled=', 'type=checkbox']);
      eq('pre[data-lang]', ['class=rm-code', 'data-lang=ts', 'data-line=15', 'data-line-end=18']);
      eq('a', ['data-href=doc.md', 'href=doc.md']);
      assert.equal(one(frag, '.rm-mermaid > pre.mermaid').textContent, 'graph TD; A-->B');
      assert.equal(one(frag, 'blockquote').className, 'rm-alert rm-alert-note');
    });

    it('keeps a task-list checkbox as a checkbox and drops other input types', () => {
      const frag = clean('<input type="checkbox" checked disabled><input type="CHECKBOX"><input type="radio"><input type="file"><input>');
      const inputs = [...frag.querySelectorAll('input')];
      assert.equal(inputs.length, 2);
      assert.ok(inputs.every((i) => i.type === 'checkbox'));
      assert.equal(inputs[0]?.checked, true);
      assert.equal(inputs[0]?.disabled, true);
    });

    it('keeps heading ids exactly, including slugs that are names of document properties', () => {
      const ids = ['intro', 'title', 'location', 'body', 'links', 'images', 'forms', 'cookie', 'domain', 'getelementbyid', 'intro-1', 'ünïcode', '日本語', 'a-b_c'];
      const frag = clean(ids.map((id) => `<h2 id="${id}" data-line="0">${id}</h2>`).join(''));
      assert.deepEqual(
        [...frag.querySelectorAll('h2')].map((h) => h.id),
        ids,
      );
    });

    it('keeps footnote references and the footnote list with their ids and fragment links', () => {
      const frag = clean(
        '<p data-line="0" data-line-end="1">text<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup></p>' +
          '<hr class="footnotes-sep"><section class="footnotes"><ol class="footnotes-list">' +
          '<li id="fn1" class="footnote-item"><p>note <a href="#fnref1" class="footnote-backref">↩︎</a></p></li></ol></section>',
      );
      assert.equal(one(frag, 'a#fnref1').getAttribute('href'), '#fn1');
      assert.equal(one(frag, 'li#fn1').className, 'footnote-item');
      assert.equal(one(frag, 'a.footnote-backref').getAttribute('href'), '#fnref1');
      assert.equal(frag.querySelectorAll('section.footnotes > ol.footnotes-list').length, 1);
      assert.equal(frag.querySelectorAll('hr.footnotes-sep').length, 1);
    });

    it('keeps tables with alignment styles and legacy align attributes', () => {
      const frag = clean(
        '<table data-line="0" data-line-end="4"><thead><tr><th style="text-align:right">A</th><th align="center" colspan="2">B</th></tr></thead>' +
          '<tbody><tr><td style="text-align:right">1</td><td rowspan="2" valign="top">2</td><td>3</td></tr></tbody>' +
          '<caption>cap</caption><colgroup><col span="2" width="50"></colgroup></table>',
      );
      assert.equal(one(frag, 'th').getAttribute('style'), 'text-align:right');
      assert.equal(one(frag, 'th[align]').getAttribute('align'), 'center');
      assert.equal(one(frag, 'th[colspan]').getAttribute('colspan'), '2');
      assert.equal(one(frag, 'td[rowspan]').getAttribute('rowspan'), '2');
      assert.equal(one(frag, 'td[valign]').getAttribute('valign'), 'top');
      assert.equal(one(frag, 'colgroup > col').getAttribute('span'), '2');
      assert.equal(one(frag, 'caption').textContent, 'cap');
    });

    it('keeps <details> with open and <summary>', () => {
      const frag = clean('<details open><summary>More <b>info</b></summary><p>body</p></details>');
      assert.equal(one(frag, 'details').hasAttribute('open'), true);
      assert.equal(one(frag, 'details > summary > b').textContent, 'info');
      assert.equal(one(frag, 'details > p').textContent, 'body');
    });

    it('leaves the real renderer output of a whole document unchanged', () => {
      const html = renderMarkdown(
        [
          '---',
          'title: x',
          '---',
          '# Title',
          '',
          'Text with `code`, **bold**, a [link](other.md#sec), a footnote[^1] and an ![img](pic.png).',
          '',
          '- [x] done',
          '- [/] working',
          '  - [ ] nested',
          '',
          '> [!WARNING]',
          '> careful',
          '',
          '| a | b |',
          '|:-:|--:|',
          '| 1 | 2 |',
          '',
          '```ts',
          'const x = 1 < 2;',
          '```',
          '',
          '```mermaid',
          'graph TD; A-->B',
          '```',
          '',
          '<div align="center"><img src="x.png" width="100" alt="x"><br><kbd>Ctrl</kbd></div>',
          '',
          '[^1]: The note.',
        ].join('\n'),
      );
      const raw = document.createElement('div');
      raw.innerHTML = html;
      assert.equal(wrap(clean(html)).innerHTML, raw.innerHTML);
    });
  });

  describe('data-vscode-context', () => {
    it('is stripped from deeply nested elements, SVG and elements created by unwrapping', () => {
      const frag = clean(
        '<div><ul><li><p data-vscode-context="{}">a</p></li></ul></div>' +
          '<svg data-vscode-context="{}"><g data-vscode-context="{}"></g></svg>' +
          '<custom-el data-vscode-context="{}"><span data-vscode-context="{}">x</span></custom-el>' +
          '<table data-vscode-context="{}"><tbody><tr><td data-VSCODE-context="{}">1</td></tr></tbody></table>',
      );
      assert.equal(frag.querySelectorAll('[data-vscode-context]').length, 0);
      assert.ok(frag.querySelectorAll('p, svg, g, span, table, td').length >= 6);
    });
  });

  describe('inline SVG', () => {
    it('keeps a static drawing with gradients, clip paths, markers, text and presentation attributes', () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50" role="img" aria-label="d">' +
        '<title>t</title><desc>d</desc>' +
        '<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="red" stop-opacity="1"></stop><stop offset="1" stop-color="blue"></stop></linearGradient>' +
        '<radialGradient id="r" cx="0.5" cy="0.5" r="0.5"></radialGradient><clipPath id="c"><rect width="10" height="10"></rect></clipPath>' +
        '<marker id="m" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto"><path d="M0 0L4 2L0 4z"></path></marker></defs>' +
        '<g transform="translate(1 2)" clip-path="url(#c)"><rect x="1" y="2" width="3" height="4" rx="1" fill="url(#g)" stroke="#000" stroke-width="2"></rect>' +
        '<circle cx="5" cy="5" r="2"></circle><ellipse cx="1" cy="1" rx="2" ry="3"></ellipse><line x1="0" y1="0" x2="5" y2="5" marker-end="url(#m)"></line>' +
        '<polyline points="0,0 1,1"></polyline><polygon points="0,0 1,1 2,0"></polygon><path d="M0 0L5 5" stroke-linecap="round" stroke-dasharray="2 1"></path></g>' +
        '<text x="1" y="2" text-anchor="middle" font-size="4"><tspan dy="1">hi</tspan></text></svg>';
      const frag = clean(svg);
      for (const tag of ['svg', 'title', 'desc', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'marker', 'g', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan']) {
        assert.ok(frag.querySelector(tag), `<${tag}> kept`);
      }
      assert.equal(one(frag, 'svg').getAttribute('viewBox'), '0 0 100 50');
      assert.equal(one(frag, 'rect[fill]').getAttribute('fill'), 'url(#g)');
      assert.equal(one(frag, 'line').getAttribute('marker-end'), 'url(#m)');
      assert.equal(one(frag, 'g').getAttribute('clip-path'), 'url(#c)');
      assert.equal(one(frag, 'stop').getAttribute('stop-color'), 'red');
      assert.equal(one(frag, 'marker').getAttribute('markerWidth'), '4');
      assert.equal(one(frag, 'text').getAttribute('text-anchor'), 'middle');
    });

    it('drops use, image, animate*, set, foreignObject and script, keeping the rest', () => {
      const frag = clean(
        '<svg><circle r="1"></circle><use href="#x"></use><image href="https://example.com/a.png"></image>' +
          '<animate attributeName="r" to="5"></animate><animateTransform attributeName="transform"></animateTransform><animateMotion></animateMotion>' +
          '<set attributeName="href" to="javascript:alert(1)"></set><foreignObject><iframe src="x"></iframe></foreignObject><script>alert(1)</script><rect width="1"></rect></svg>',
      );
      assert.equal(frag.querySelectorAll('use, image, animate, animateTransform, animateMotion, set, foreignObject, iframe, script').length, 0);
      assert.equal(frag.querySelectorAll('circle, rect').length, 2);
    });

    it('drops xlink:href but keeps a safe href on svg anchors', () => {
      const frag = clean('<svg><a xlink:href="https://example.com"><text>x</text></a><a href="https://example.com"><text>y</text></a></svg>');
      const anchors = [...frag.querySelectorAll('a')];
      assert.equal(anchors.length, 2);
      assert.equal(anchors[0]?.hasAttribute('xlink:href'), false);
      assert.equal(anchors[1]?.getAttribute('href'), 'https://example.com');
    });

    it('keeps svg <style>', () => {
      const frag = clean('<svg><style>.a > rect { fill: red }</style><rect class="a" width="1" height="1"></rect></svg>');
      assert.equal(one(frag, 'style').textContent, '.a > rect { fill: red }');
    });
  });

  describe('DOM clobbering', () => {
    it('allows name on <a> (anchors) only', () => {
      const frag = clean('<a name="top">t</a><img name="body" src="x.png"><img id="x" name="getElementById" src="y.png">');
      assert.equal(one(frag, 'a').getAttribute('name'), 'top');
      assert.equal(frag.querySelectorAll('img[name]').length, 0);
      assert.equal(frag.querySelectorAll('img').length, 2);
    });

    it('does not let form controls or embedded objects shadow document properties', () => {
      const frag = clean('<form id="x" name="cookie"><input name="action"></form><object name="body"></object><embed name="body"><iframe name="body"></iframe>');
      assert.equal(frag.querySelectorAll('form, input, object, embed, iframe').length, 0);
    });
  });

  describe('media and misc elements', () => {
    it('keeps video, audio, source and track with their attributes', () => {
      const frag = clean(
        '<video controls loop muted poster="https://example.com/p.png" width="320"><source src="a.mp4" type="video/mp4"><track kind="captions" src="a.vtt" srclang="en" label="English" default></video>' +
          '<audio controls src="a.mp3"></audio>',
      );
      assert.equal(one(frag, 'video').hasAttribute('controls'), true);
      assert.equal(one(frag, 'video').getAttribute('poster'), 'https://example.com/p.png');
      assert.equal(one(frag, 'video > source').getAttribute('src'), 'a.mp4');
      assert.equal(one(frag, 'track').getAttribute('srclang'), 'en');
      assert.equal(one(frag, 'audio').getAttribute('src'), 'a.mp3');
    });

    it('keeps GitHub-flavoured inline HTML', () => {
      const frag = clean(
        '<p align="center"><kbd>K</kbd> <sub>s</sub><sup>u</sup> <mark>m</mark> <del>d</del><ins>i</ins> <s>s</s> <u>u</u> <small>s</small> <abbr title="t">a</abbr> <cite>c</cite> <q>q</q> <dfn>d</dfn> <var>v</var> <samp>s</samp> <time datetime="2024-01-01">t</time> <ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby> a<wbr>b</p>' +
          '<dl><dt>t</dt><dd>d</dd></dl><figure><img src="a.png" alt="a"><figcaption>cap</figcaption></figure><hr><br>' +
          '<section><header>h</header><article>a</article><aside>s</aside><nav>n</nav><footer>f</footer></section>',
      );
      for (const tag of ['kbd', 'sub', 'sup', 'mark', 'del', 'ins', 's', 'u', 'small', 'abbr', 'cite', 'q', 'dfn', 'var', 'samp', 'time', 'ruby', 'rt', 'rp', 'wbr', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'hr', 'section', 'header', 'article', 'aside', 'nav', 'footer']) {
        assert.ok(frag.querySelector(tag), `<${tag}> kept`);
      }
      assert.equal(one(frag, 'p').getAttribute('align'), 'center');
      assert.equal(one(frag, 'time').getAttribute('datetime'), '2024-01-01');
    });
  });
});
