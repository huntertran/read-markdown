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
    assert.match(r.html, /<h2 data-line="6" id="setup-fast-1">/);
  });

  it('annotates blocks with data-line and reports block lines', () => {
    const r = render('para one\n\n- a\n- b\n\n```js\nconst x = 1;\n```\n', opts);
    assert.match(r.html, /<p data-line="0">/);
    assert.match(r.html, /<ul data-line="2">/);
    assert.match(r.html, /<li data-line="3">/);
    assert.match(r.html, /<pre class="rm-code" data-line="5" data-lang="js">/);
    assert.deepEqual(r.blockLines, [0, 2, 3, 5]);
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
    assert.match(r.html, /<blockquote data-line="0" class="rm-alert rm-alert-warning">/);
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
});
