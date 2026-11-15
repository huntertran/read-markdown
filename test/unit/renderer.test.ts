import * as assert from 'node:assert/strict';
import { createMarkdownRenderer } from '../../src/render/markdown';

const render = createMarkdownRenderer();
const opts = { mermaid: true };

describe('markdown renderer', () => {
  it('collects top-level headings with unique slugs and source lines', () => {
    const r = render('# Title\n\ntext\n\n## Setup *fast*\n\n## Setup fast\n\n> # quoted\n', opts);
    assert.deepEqual(
      r.headings.map((h) => [h.level, h.text, h.slug, h.line]),
      [
        [1, 'Title', 'title', 0],
        [2, 'Setup fast', 'setup-fast', 4],
        [2, 'Setup fast', 'setup-fast-1', 6],
      ],
    );
    assert.match(r.html, /<h2 data-line="6" data-line-end="7" id="setup-fast-1">/);
  });

  it('annotates blocks with data-line and reports block lines', () => {
    const r = render('para one\n\n- a\n- b\n\n```js\nconst x = 1;\n```\n', opts);
    assert.match(r.html, /<p data-line="0" data-line-end="1">/);
    assert.match(r.html, /<ul data-line="2" data-line-end="5">/);
    assert.match(r.html, /<li data-line="3" data-item-end="5">/);
    assert.match(r.html, /<pre class="rm-code" data-line="5" data-line-end="8" data-lang="js">/);
    assert.deepEqual(r.blockLines, [0, 2, 3, 5]);
  });

  it('marks the end line only on top-level blocks', () => {
    const src = '# H\n\n> quote\n> more\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n    code\n\n---\n\n```mermaid\ngraph TD\n```\n';
    const r = render(src, opts);
    assert.match(r.html, /<h1 data-line="0" data-line-end="1"/);
    assert.match(r.html, /<blockquote data-line="2" data-line-end="4">\n<p data-line="2">/);
    assert.match(r.html, /<table data-line="5" data-line-end="8">\n<thead data-line="5">/);
    assert.match(r.html, /<pre class="rm-code" data-line="9" data-line-end="10">/);
    assert.match(r.html, /<hr data-line="11" data-line-end="12">/);
    assert.match(r.html, /<div class="rm-mermaid" data-line="13" data-line-end="16">/);
    // Nested blocks have no end line: their ranges overlap the parent's.
    assert.equal(r.html.match(/data-line-end=/g)?.length, 6);
  });

  it('marks list items with their end line for reordering', () => {
    const r = render('- a\n- b\n  - b1\n- c\n\npara\n', opts);
    assert.match(r.html, /<li data-line="0" data-item-end="1">/);
    assert.match(r.html, /<li data-line="1" data-item-end="3">/);
    assert.match(r.html, /<li data-line="2" data-item-end="3">/);
    assert.match(r.html, /<li data-line="3" data-item-end="5">/);
    assert.match(r.html, /<ul data-line="0" data-line-end="5">/);
  });

  it('gives front matter an editable line range', () => {
    assert.match(render('---\ntitle: x\n---\n# H\n', opts).html, /<details class="rm-frontmatter" data-line="0" data-line-end="3">/);
    // Closing fence on the last line without a newline is still inside the range.
    assert.match(render('---\r\ntitle: x\r\n---', opts).html, /data-line="0" data-line-end="3">/);
  });

  it('highlights known languages and escapes unknown ones', () => {
    const r = render('```ts\nlet a = "x";\n```\n\n```nolang\n<b>\n```\n', opts);
    assert.match(r.html, /class="hljs language-ts"/);
    assert.match(r.html, /hljs-keyword/);
    assert.match(r.html, /&lt;b&gt;/);
  });

  it('renders mermaid fences as diagram placeholders only when enabled', () => {
    const src = '```mermaid\ngraph TD; A-->B\n```\n';
    const on = render(src, { mermaid: true });
    assert.equal(on.hasMermaid, true);
    assert.match(on.html, /<pre class="mermaid">graph TD; A--&gt;B\n<\/pre>/);
    const off = render(src, { mermaid: false });
    assert.equal(off.hasMermaid, false);
    assert.doesNotMatch(off.html, /class="mermaid"/);
  });

  it('rewrites relative image sources but not absolute URLs', () => {
    const r = render('![a](img/a.png) ![b](https://x.test/b.png) ![c](data:image/png;base64,AA)', {
      mermaid: false,
      resolveResource: (p) => `vscode-resource:/${p}`,
    });
    assert.match(r.html, /src="vscode-resource:\/img\/a.png"/);
    assert.match(r.html, /src="https:\/\/x.test\/b.png"/);
    assert.match(r.html, /src="data:image\/png;base64,AA"/);
  });

  it('keeps original link targets in data-href', () => {
    const r = render('[doc](other.md#part)', opts);
    assert.match(r.html, /href="other.md#part" data-href="other.md#part"/);
  });

  it('renders front matter as a collapsible block and keeps line numbers aligned', () => {
    const r = render('---\ntitle: x\n---\n# Heading\n', opts);
    assert.match(r.html, /<details class="rm-frontmatter"/);
    assert.equal(r.headings[0].line, 3);
    assert.doesNotMatch(r.html, /<hr/);
  });

  it('renders GitHub alerts', () => {
    const r = render('> [!WARNING]\n> Be careful\n', opts);
    assert.match(r.html, /<blockquote data-line="0" data-line-end="2" class="rm-alert rm-alert-warning">/);
    assert.match(r.html, /<span class="rm-alert-title">Warning<\/span>Be careful/);
  });

  it('renders all five GitHub alert types, case-insensitively', () => {
    for (const [marker, kind, title] of [
      ['NOTE', 'note', 'Note'],
      ['TIP', 'tip', 'Tip'],
      ['IMPORTANT', 'important', 'Important'],
      ['WARNING', 'warning', 'Warning'],
      ['caution', 'caution', 'Caution'],
    ]) {
      const r = render(`> [!${marker}]\n> Body\n`, opts);
      assert.match(r.html, new RegExp(`class="rm-alert rm-alert-${kind}"`), marker);
      assert.match(r.html, new RegExp(`<span class="rm-alert-title">${title}</span>Body`), marker);
    }
    assert.doesNotMatch(render('> [!BUG]\n> Body\n', opts).html, /rm-alert/);
  });

  it('renders task lists', () => {
    const r = render('- [x] done\n- [ ] todo\n', opts);
    assert.match(r.html, /task-list-item/);
    assert.match(r.html, /checked/);
  });

  it('renders in-progress task items as unchecked items flagged active', () => {
    for (const marker of ['/', '~', '-']) {
      const r = render(`- [ ] todo\n- [${marker}] working \`on\` it\n- [x] done\n`, opts);
      const items = r.html.match(/<li[^>]*>.*?<\/li>/g) ?? [];
      assert.equal(items.length, 3, marker);
      const open = items[1].slice(0, items[1].indexOf('>') + 1);
      for (const attr of ['class="task-list-item"', 'data-line="1"', 'data-task="active"']) assert.ok(open.includes(attr), `${marker}: ${open}`);
      assert.match(items[1], /<input class="task-list-item-checkbox" disabled="" type="checkbox"> working <code>on<\/code> it/, marker);
      assert.doesNotMatch(items[1], /\[[/~-]\]/, marker);
      assert.doesNotMatch(items[0] + items[2], /data-task/, marker);
    }
  });

  it('flags in-progress items in nested, ordered, loose and quoted lists', () => {
    const r = render('1. [/] parent\n   - [/] child\n\n2. [ ] next\n\n> - [~] quoted\n', opts);
    assert.equal(r.html.match(/data-task="active"/g)?.length, 3);
    assert.match(r.html, /<li data-task="active" class="task-list-item" data-line="0" data-item-end="3">/);
    assert.match(r.html, /<li data-task="active" class="task-list-item" data-line="1" data-item-end="3">/);
    assert.doesNotMatch(r.html, /\[[/~]\]/);
  });

  it('shows in-progress markers as plain text when activeTasks is off', () => {
    const r = render('- [/] working\n- [x] done\n', { mermaid: true, activeTasks: false });
    assert.doesNotMatch(r.html, /data-task/);
    assert.match(r.html, /<li data-line="0" data-item-end="1">\[\/\] working<\/li>/);
    assert.match(r.html, /checked/);
  });

  it('leaves in-progress markers alone where they are not task markers', () => {
    for (const src of ['[/] not a list\n', '- text [/] later\n', '- [/]\n', '- [/]no space\n']) {
      const r = render(src, opts);
      assert.doesNotMatch(r.html, /data-task|task-list-item/, src);
      assert.match(r.html, /\[\/\]/, src);
    }
  });

  describe('rendered ranges for host-side validation', () => {
    it('collects lists with two or more items, nested lists separately', () => {
      const r = render('- a\n- b\n  - b1\n  - b2\n  - b3\n- c\n\ntext\n\n- single\n\ntext\n\n1. x\n2. y\n', opts);
      assert.deepEqual(r.lists, [
        { starts: [2, 3, 4], end: 5 },
        { starts: [0, 1, 5], end: 7 },
        { starts: [13, 14], end: 15 },
      ]);
    });

    it('collects ordered lists, lists in blockquotes and loose lists', () => {
      const r = render('3. a\n4. b\n\n> - q1\n> - q2\n\n- l1\n\n- l2\n\n- l3\n', opts);
      assert.deepEqual(r.lists, [
        { starts: [0, 1], end: 3 },
        { starts: [3, 4], end: 5 },
        { starts: [6, 8, 10], end: 11 },
      ]);
    });

    it('reports the same values as the data-line / data-item-end attributes of the items', () => {
      const r = render('- a\n- b\n  - c\n  - d\n- e\n', opts);
      for (const list of r.lists) {
        for (const s of list.starts) assert.match(r.html, new RegExp(`<li data-line="${s}" data-item-end="\\d+">`));
        const last = list.starts[list.starts.length - 1];
        assert.match(r.html, new RegExp(`<li data-line="${last}" data-item-end="${list.end}">`));
      }
    });

    it('collects task items, in-progress markers included, but not lookalikes', () => {
      const r = render('- [ ] a\n- [x] b\n  - [/] c\n  - [~] d\n- [-] e\n- [ ]f\n- plain\n\n1. [ ] n\n', opts);
      assert.deepEqual(r.taskLines, [0, 1, 2, 3, 4, 8]);
    });

    it('does not collect in-progress items when activeTasks is off', () => {
      const r = render('- [ ] a\n- [/] b\n- [x] c\n', { mermaid: true, activeTasks: false });
      assert.deepEqual(r.taskLines, [0, 2]);
    });

    it('collects task items in blockquotes and nested lists', () => {
      const r = render('> - [ ] q\n> - [x] r\n\n- a\n  - [ ] nested\n', opts);
      assert.deepEqual(r.taskLines, [0, 1, 4]);
    });
  });

  describe('raw HTML cannot impersonate renderer output', () => {
    it('drops line attributes from author HTML and keeps the real ones', () => {
      const r = render('before\n\n<div data-line="0" data-line-end="999" class="x">forged</div>\n\n- a\n- b\n\nafter\n', opts);
      assert.doesNotMatch(r.html, /data-line-end="999"/);
      assert.doesNotMatch(r.html, /data-line="0" data-line-end="999"/);
      // The author's values are gone; the renderer stamps the real ones on the block's first tag.
      assert.match(r.html, /<div data-line="2" data-line-end="3" data-rm-html="" class="x">forged<\/div>/);
      assert.match(r.html, /<p data-line="0" data-line-end="1">before<\/p>/);
      assert.match(r.html, /<ul data-line="4" data-line-end="7">/);
      assert.match(r.html, /<li data-line="4" data-item-end="5">/);
      assert.match(r.html, /<p data-line="7" data-line-end="8">after<\/p>/);
    });

    it('drops reserved attributes from inline HTML, including data-href', () => {
      const r = render(
        'text <span data-line=5 DATA-ITEM-END=6 data-task="active" data-rm-x>s</span> and <a href="https://good.example" data-href="https://evil.example">link</a>\n',
        opts,
      );
      assert.doesNotMatch(r.html, /<span[^>]*data-(line|item-end|task|rm-)/i);
      assert.doesNotMatch(r.html, /evil\.example/);
      assert.match(r.html, /<a href="https:\/\/good\.example">link<\/a>/);
    });

    it('keeps data-href on markdown links and the attributes the renderer writes itself', () => {
      const r = render('[a](rel.md) ![i](p.png)\n\n- [ ] t\n- [/] u\n\n```mermaid\ngraph TD\n```\n', {
        mermaid: true,
        resolveResource: () => 'v://p.png',
      });
      assert.match(r.html, /<a href="rel\.md" data-href="rel\.md">/);
      assert.match(r.html, /<li class="task-list-item" data-line="2" data-item-end="3">/);
      assert.match(r.html, /<li data-task="active" class="task-list-item" data-line="3" data-item-end="5">/);
      assert.match(r.html, /<div class="rm-mermaid" data-line="5" data-line-end="8">/);
      assert.match(r.html, /<img src="v:\/\/p\.png"/);
    });

    it('keeps front matter, alerts and footnotes working', () => {
      const r = render('---\na: 1\n---\n> [!NOTE]\n> hi\n\nfoot[^1]\n\n[^1]: note\n', opts);
      assert.match(r.html, /<details class="rm-frontmatter" data-line="0" data-line-end="3">/);
      assert.match(r.html, /<blockquote data-line="3" data-line-end="5" class="rm-alert rm-alert-note">/);
      assert.match(r.html, /rm-alert-title/);
      assert.match(r.html, /footnote-ref/);
    });

    it('does not let an unterminated tag swallow the real attributes of the next block', () => {
      const r = render('<div title="x"\n\ntext\n', opts);
      assert.match(r.html, /<div data-line="0" data-line-end="1" data-rm-html="" title="x"\n>/);
      assert.match(r.html, /<p data-line="2" data-line-end="3">text<\/p>/);
    });
  });

  describe('raw HTML blocks carry line attributes for track changes', () => {
    const count = (html: string, attr: string) => html.split(` ${attr}`).length - 1;

    it('stamps the first tag of a top-level block with data-line, data-line-end and data-rm-html', () => {
      const r = render('text\n\n<div class="a">old</div>\n\nafter\n', opts);
      assert.match(r.html, /<div data-line="2" data-line-end="3" data-rm-html="" class="a">old<\/div>/);
      assert.deepEqual(r.topBlocks.map((b) => [b.line, b.end, b.kind]), [[0, 1, 'paragraph_open'], [2, 3, 'html_block'], [4, 5, 'paragraph_open']]);
    });

    it('stamps a nested block with data-line only', () => {
      const r = render('> <div>quoted</div>\n', opts);
      assert.match(r.html, /<div data-line="0" data-rm-html="">quoted<\/div>/);
      assert.equal(count(r.html, 'data-line-end'), 1); // the blockquote's
      assert.match(r.html, /<blockquote data-line="0" data-line-end="1">/);
    });

    it('replaces author-written values, leaving one of each attribute with the real value', () => {
      const r = render('a\n\n<div data-line="99" data-line-end="100" data-rm-html class="x" DATA-RM-HTML="1">forged</div>\n', opts);
      const tag = /<div[^>]*>/.exec(r.html)?.[0] ?? '';
      assert.equal(tag, '<div data-line="2" data-line-end="3" data-rm-html="" class="x">');
      assert.doesNotMatch(r.html, /99|100/);
    });

    it('handles the usual tag forms', () => {
      const cases: [string, RegExp][] = [
        ['<img src=x>\n', /^<img data-line="0" data-line-end="1" data-rm-html="" src=x>/],
        ['<br/>\n', /^<br data-line="0" data-line-end="1" data-rm-html=""\/>/],
        // (An `<svg` whose tag continues on the next line is not an HTML block in CommonMark, so the tag ends on the first line here.)
        ['<svg viewBox="0 0 1 1">\n<path d="M0 0"/>\n</svg>\n', /^<svg data-line="0" data-line-end="3" data-rm-html="" viewBox="0 0 1 1">/],
        ['<DIV>x</DIV>\n', /^<DIV data-line="0" data-line-end="1" data-rm-html="">x<\/DIV>/],
        ['   <div>x</div>\n', /^ {3}<div data-line="0" data-line-end="1" data-rm-html="">x<\/div>/],
        ['<details><summary>s</summary>b</details>\n', /^<details data-line="0" data-line-end="1" data-rm-html="">/],
      ];
      for (const [src, expected] of cases) assert.match(render(src, opts).html, expected, src);
    });

    it('stamps only the first element of a block with several roots', () => {
      const r = render('<div>a</div><div>b</div>\n', opts);
      assert.equal(count(r.html, 'data-rm-html'), 1);
      assert.match(r.html, /^<div data-line="0" data-line-end="1" data-rm-html="">a<\/div><div>b<\/div>/);
    });

    it('does not stamp comments, closing tags, script or style blocks', () => {
      const cases = ['<!-- note -->\n', '<?php x ?>\n', '<!DOCTYPE html>\n', '<script>var a = 1;</script>\n', '<SCRIPT>x</SCRIPT>\n', '<style>p { color: red }</style>\n', '<Style>p{}</Style>\n'];
      for (const src of cases) {
        const r = render(src, opts);
        assert.doesNotMatch(r.html, /data-rm-html/, src);
        assert.doesNotMatch(r.html, /data-line/, src);
      }
    });

    it('leaves the closing block of a split <div> unmarked and the middle Markdown block as before', () => {
      const r = render('<div>\n\nmiddle\n\n</div>\n', opts);
      assert.match(r.html, /^<div data-line="0" data-line-end="1" data-rm-html="">\n<p data-line="2" data-line-end="3">middle<\/p>\n<\/div>\n$/);
      assert.equal(count(r.html, 'data-rm-html'), 1);
    });

    it('keeps the output well formed when the first tag is unterminated', () => {
      const r = render('<div class="a\n\nnext\n', opts);
      assert.match(r.html, /^<div data-line="0" data-line-end="1" data-rm-html="" class="a\n">/);
      assert.match(r.html, /<p data-line="2" data-line-end="3">next<\/p>/);
    });
  });
});
