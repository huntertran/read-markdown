import * as assert from 'node:assert/strict';
import { RESERVED_ATTRIBUTES, neutralizeReservedAttributes as clean, stampRawHtmlBlock } from '../../src/render/rawHtml';

/** True if `html` still has `name` as an attribute name (preceded by a separator, followed by one). */
function hasAttr(html: string, name: string): boolean {
  return new RegExp(`[\\s"'/]${name}(?=[\\s=/>])`, 'i').test(html);
}

describe('neutralizeReservedAttributes', () => {
  it('leaves HTML without reserved attributes untouched', () => {
    for (const html of [
      '<div class="a" id="b">x</div>',
      'plain text, no tags',
      '<a href="https://example.com" data-foo="1">link</a>',
      '<img src=a.png alt="a > b">',
      '<!-- a comment -->',
      'a < b and c > d',
    ]) {
      assert.equal(clean(html), html);
    }
  });

  it('removes each reserved attribute, keeping the others', () => {
    for (const name of RESERVED_ATTRIBUTES) {
      assert.equal(clean(`<div class="a" ${name}="3" id="b">x</div>`), '<div class="a" id="b">x</div>', name);
    }
    assert.equal(clean('<span data-rm-del-before="1" data-rm-anything x>t</span>'), '<span x>t</span>');
  });

  it('is case-insensitive', () => {
    assert.equal(clean('<div DATA-LINE="1" Data-Line-End="2" dAtA-iTeM-eNd=3>x</div>'), '<div>x</div>');
    assert.equal(clean('<p DATA-RM-Foo="1">x</p>'), '<p>x</p>');
  });

  it('handles unquoted, single-quoted and valueless forms', () => {
    assert.equal(clean('<div data-line=3 id=a>x</div>'), '<div id=a>x</div>');
    assert.equal(clean("<div data-line='3' id=a>x</div>"), '<div id=a>x</div>');
    assert.equal(clean('<div data-task id=a>x</div>'), '<div id=a>x</div>');
    assert.equal(clean('<div data-task>x</div>'), '<div>x</div>');
    assert.equal(clean('<div id=a data-href=>x</div>'), '<div id=a>x</div>');
  });

  it('handles whitespace around the equals sign and odd separators', () => {
    assert.equal(clean('<div data-line\n=\n"3">x</div>'), '<div>x</div>');
    assert.equal(clean('<div\tdata-line\t=\t3\tid=a>x</div>'), '<div\tid=a>x</div>');
    assert.equal(clean('<div\fdata-line=3>x</div>'), '<div>x</div>');
    assert.equal(clean('<div/data-line=1>x</div>'), '<div/>x</div>');
    assert.equal(clean('<div/ / data-line=1 />x</div>'), '<div/ / />x</div>');
    assert.equal(clean('<div id="a"data-line="1">x</div>'), '<div id="a">x</div>');
  });

  it('removes every duplicate (a browser keeps the first one)', () => {
    assert.equal(clean('<div data-line=1 data-line=2 DATA-LINE=3>x</div>'), '<div>x</div>');
  });

  it('does not treat a `>` inside a quoted value as the end of the tag', () => {
    assert.equal(clean('<div title="a>b" data-line="1" data-line-end=\'2>\' id=z>x</div>'), '<div title="a>b" id=z>x</div>');
    assert.equal(clean('<a title=\'x " > y\' data-href="evil">t</a>'), '<a title=\'x " > y\'>t</a>');
  });

  it('over-removes a reserved name inside another attribute value (the safety net is context-free)', () => {
    // `/` is part of an unquoted value, so a browser sees one attribute `a`; removing is still the safe choice.
    assert.equal(clean('<div a=1/data-line=2>x</div>'), '<div a=1/>x</div>');
    assert.equal(clean('<div title="data-line=1 b">x</div>'), '<div title=" b">x</div>');
  });

  it('keeps names that only share a prefix with a reserved one', () => {
    for (const name of ['data-lineage', 'data-line-ends', 'data-lines', 'data-tasks', 'data-hrefs', 'data-item-ends', 'data-rm', 'data-move', 'x-data-line-y']) {
      const html = `<div ${name}="1">x</div>`;
      assert.equal(clean(html), html, name);
    }
  });

  it('handles self-closing tags and several tags in one block', () => {
    assert.equal(clean('<br data-line="1"/><img src=a data-href=x / ><hr/>'), '<br/><img src=a / ><hr/>');
    const block = '<div data-line="1">\n  <p data-line-end="2">a</p>\n  <a href="x" data-href="y">b</a>\n</div>\n';
    const out = clean(block);
    assert.ok(!hasAttr(out, 'data-line') && !hasAttr(out, 'data-line-end') && !hasAttr(out, 'data-href'));
    assert.match(out, /<a href="x">b<\/a>/);
  });

  it('handles markdown mixed into an HTML block and text between tags', () => {
    const out = clean('<div data-line="1">\n\n**bold** and text\n\n</div>');
    assert.equal(out, '<div>\n\n**bold** and text\n\n</div>');
  });

  it('cleans end tags as well', () => {
    assert.equal(clean('</div data-line=1>'), '</div>');
  });

  it('removes attributes in tags that follow a comment containing a quote', () => {
    // A tokenizer that does not model comments loses track here; the safety net still removes the attribute.
    const out = clean('<!-- <a title="--> <div data-line=3 b="-->');
    assert.ok(!/data-line\s*=/.test(out), out);
  });

  it('removes attributes hidden after raw-text elements', () => {
    const out = clean('<textarea><a title="</textarea><div data-line=3 data-line-end=4>x</div>');
    assert.ok(!/data-line\s*=/.test(out) && !/data-line-end\s*=/.test(out), out);
  });

  it('removes attributes in svg foreign content', () => {
    const out = clean('<svg><style><div data-line=1 data-item-end=2></style></svg>');
    assert.ok(!/data-(line|item-end)\s*=/.test(out), out);
  });

  it('does not let removal assemble a reserved name from the pieces around it', () => {
    const out = clean('<!--data-lidata-line=1ne=2 -->');
    assert.ok(!/data-line\s*=/.test(out), out);
    const nested = clean('<div data-lidata-lidata-line=1ne=1ne=2>x</div>');
    assert.ok(!/data-line\s*=/i.test(nested), nested);
  });

  it('closes a tag left open at the end so it cannot swallow the next real tag', () => {
    assert.equal(clean('<div class="a"'), '<div class="a">');
    assert.equal(clean('<div title="abc'), '<div title="abc">');
    assert.equal(clean('<div data-line="1"\n'), '<div\n>');
    assert.equal(clean('<div'), '<div>');
    assert.equal(clean('<div title="x" data-line="unterminated'), '<div title="x">');
  });

  describe('deliberately nested input (several removal rounds)', () => {
    /**
     * `depth` reserved attributes nested in each other inside a comment (the tag tokenizer skips comments, so only the
     * safety net works on it): `data-li` x depth + `data-line="0"` + `ne="1"` ... `ne="depth"`. Each round removes the
     * innermost `data-line="..."`, which glues the `data-li` before it to the `ne="..."` after it, and that is the
     * next `data-line="..."`. So `depth` removals take about `depth` changing rounds.
     */
    function nested(depth: number): string {
      let html = `<!--${'data-li'.repeat(depth)}data-line="0"`;
      for (let i = 1; i <= depth; i++) html += `ne="${i}"`;
      return `${html}-->`;
    }

    it('cleans an input that needs several rounds but stays under the limit', () => {
      // Measured against MAX_ROUNDS = 8: depth 6 is the deepest that still comes out clean, depth 7 is the first that fails closed.
      for (const depth of [1, 3, 6]) {
        const out = clean(nested(depth));
        assert.ok(!/data-line\s*=/i.test(out), `depth ${depth}: ${out}`);
        assert.equal(out, '<!---->', `depth ${depth}`);
      }
    });

    it('fails closed (returns an empty string) when the removals keep exposing new ones past the round limit', () => {
      for (const depth of [7, 8, 20]) {
        assert.equal(clean(nested(depth)), '', `depth ${depth}`);
      }
    });

    it('keeps the surrounding text out of the result when it fails closed', () => {
      assert.equal(clean(`<p>before</p>${nested(12)}<p>after</p>`), '');
    });
  });

  it('is idempotent', () => {
    for (const html of ['<div data-line=1 data-lidata-line=2ne=3>', '<div title="a', '<p DATA-RM-X=1>', 'text <b data-task>']) {
      const once = clean(html);
      assert.equal(clean(once), once, html);
    }
  });
});

describe('stampRawHtmlBlock', () => {
  const ATTRS = ' data-line="3" data-line-end="5"';
  const STAMP = `${ATTRS} data-rm-html=""`;

  it('inserts the attributes directly after the name of the first opening tag', () => {
    assert.equal(stampRawHtmlBlock('<div class="a">x</div>\n', ATTRS), `<div${STAMP} class="a">x</div>\n`);
    assert.equal(stampRawHtmlBlock('<img src=x>\n', ATTRS), `<img${STAMP} src=x>\n`);
    assert.equal(stampRawHtmlBlock('<br/>\n', ATTRS), `<br${STAMP}/>\n`);
    assert.equal(stampRawHtmlBlock('<svg\n viewBox="0 0 1 1">', ATTRS), `<svg${STAMP}\n viewBox="0 0 1 1">`);
    assert.equal(stampRawHtmlBlock('<DIV>x</DIV>', ATTRS), `<DIV${STAMP}>x</DIV>`);
    assert.equal(stampRawHtmlBlock('   <p>x</p>', ATTRS), `   <p${STAMP}>x</p>`);
    assert.equal(stampRawHtmlBlock('<my-element>x</my-element>', ATTRS), `<my-element${STAMP}>x</my-element>`);
  });

  it('stamps only the first tag', () => {
    const out = stampRawHtmlBlock('<div>a</div><div>b</div>', ATTRS);
    assert.equal(out, `<div${STAMP}>a</div><div>b</div>`);
  });

  it('stamps data-line only when the token has no end line', () => {
    assert.equal(stampRawHtmlBlock('<div>x</div>', ' data-line="3"'), '<div data-line="3" data-rm-html="">x</div>');
  });

  it('leaves blocks without an opening tag unchanged', () => {
    for (const html of [
      '<!-- c -->\n',
      '  <!-- c --><div>x</div>',
      '</div>\n',
      '<?php echo 1; ?>',
      '<!DOCTYPE html>',
      '<![CDATA[ x ]]>',
      '< div>x</div>',
      '<1a>x',
      'text <div>x</div>',
      '',
    ]) {
      assert.equal(stampRawHtmlBlock(html, ATTRS), html);
    }
  });

  it('leaves script and style blocks unchanged, whatever the case', () => {
    for (const html of ['<script>a</script>', '<SCRIPT src=x></SCRIPT>', '<style>p{}</style>', '<Style\n>p{}</Style>', ' <script\n>']) {
      assert.equal(stampRawHtmlBlock(html, ATTRS), html);
    }
    // Only the exact names: these are ordinary elements.
    assert.match(stampRawHtmlBlock('<scripty>x</scripty>', ATTRS), /data-rm-html/);
  });

  it('stamps nothing without line attributes', () => {
    assert.equal(stampRawHtmlBlock('<div>x</div>', ''), '<div>x</div>');
  });

  it('removes author-written data-rm-html (any form) before the renderer adds its own', () => {
    for (const author of ['<div data-rm-html>x</div>', '<div data-rm-html="">x</div>', '<div DATA-RM-HTML=1>x</div>', "<div data-rm-html='a'>x</div>"]) {
      assert.equal(clean(author), '<div>x</div>', author);
      assert.equal(stampRawHtmlBlock(clean(author), ATTRS), `<div${STAMP}>x</div>`, author);
    }
  });

  it('combines with an unterminated first tag into well formed output', () => {
    assert.equal(stampRawHtmlBlock(clean('<div class="a\n'), ATTRS), `<div${STAMP} class="a\n">`);
    assert.equal(stampRawHtmlBlock(clean('<div'), ATTRS), `<div${STAMP}>`);
  });
});
