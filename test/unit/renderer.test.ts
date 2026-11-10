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
});
