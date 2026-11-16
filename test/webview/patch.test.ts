import * as assert from 'node:assert/strict';
import { configMessage, renderMessage, usePreview } from './preview';

// Incremental re-render (webview/patch.ts, wired in app.ts renderContent). The contract: a patched
// render leaves `#rm-content` exactly as a full render of the same message would (`assertLikeFull`),
// while the blocks it did not change keep their elements (and so their decorations, Mermaid SVG,
// collapsed sections and table widths).
//
// Not covered here (manual / bench): the style and layout work a patch saves in a real browser.

const DOC = [
  'Intro paragraph.',
  '',
  '# One',
  '',
  'First section text.',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '## One A',
  '',
  '- item a',
  '- item b',
  '- [ ] task c',
  '',
  'Tail of one A.',
  '',
  '# Two',
  '',
  '| h1 | h2 |',
  '| --- | --- |',
  '| c1 | c2 |',
  '',
  'Second section text.',
  '',
  '> quoted',
  '',
].join('\n');

describe('incremental render (patch)', () => {
  const preview = usePreview();
  let version = 1;
  const content = () => preview.content;
  const blocks = () => [...content().querySelectorAll<HTMLElement>('[data-line-end]')];
  const byText = () => new Map(blocks().map((el) => [el.textContent, el]));

  function render(markdown: string, opts: Parameters<typeof renderMessage>[1] = {}): void {
    preview.send(renderMessage(markdown, { docVersion: ++version, ...opts }));
  }

  /** The content after a full render of the last message (a config change that re-renders forces one). */
  function fullRenderHtml(): string {
    preview.send(configMessage({ navMaxDepth: 5 }));
    preview.send(configMessage());
    return content().innerHTML;
  }

  function assertLikeFull(): void {
    const patched = content().innerHTML;
    assert.equal(patched, fullRenderHtml());
  }

  /** Renders `next` after `DOC` (both from a clean full render) and returns the blocks of DOC by text. */
  function patchFromDoc(next: string): Map<string | null, HTMLElement> {
    preview.send(configMessage());
    render('# Reset\n');
    render(DOC);
    const before = byText();
    render(next);
    return before;
  }

  it('changing one paragraph replaces only that block', () => {
    const before = patchFromDoc(DOC.replace('Tail of one A.', 'Tail of one A, edited.'));
    for (const el of blocks()) {
      const old = before.get(el.textContent);
      if (el.textContent === 'Tail of one A, edited.') assert.equal(old, undefined);
      else assert.equal(old, el, `kept: ${el.textContent}`);
    }
    assertLikeFull();
  });

  it('lines added above shift the line attributes of every kept block', () => {
    const before = patchFromDoc(DOC.replace('Intro paragraph.', 'Intro paragraph.\n\nA new paragraph,\nover two lines.'));
    const second = before.get('Second section text.');
    assert.equal(blocks().find((b) => b.textContent === 'Second section text.'), second);
    assertLikeFull();
  });

  it('blank lines alone keep every element and only shift lines', () => {
    const before = patchFromDoc(DOC.replace('# Two', '\n\n\n# Two'));
    for (const el of blocks()) assert.equal(before.get(el.textContent), el);
    assertLikeFull();
  });

  it('a block inserted right after a heading goes into that section', () => {
    patchFromDoc(DOC.replace('# Two\n', '# Two\n\nFirst of two.\n'));
    const first = blocks().find((b) => b.textContent === 'First of two.')!;
    assert.equal(first.closest('section')?.getAttribute('data-slug'), 'two');
    assertLikeFull();
  });

  it('a block inserted at the very start, and a block deleted', () => {
    patchFromDoc(`Very first.\n\n${DOC}`);
    assertLikeFull();
    patchFromDoc(DOC.replace('> quoted\n', ''));
    assert.equal(content().querySelector('blockquote'), null);
    assertLikeFull();
  });

  it('a new code block gets one copy button, kept ones keep theirs', () => {
    patchFromDoc(DOC.replace('Second section text.', '```py\nprint(1)\n```'));
    for (const pre of content().querySelectorAll('pre.rm-code')) assert.equal(pre.querySelectorAll(':scope > button.rm-copy').length, 1);
    assertLikeFull();
  });

  it('a reordered list and a toggled task replace the list', () => {
    patchFromDoc(DOC.replace('- item a\n- item b', '- item b\n- item a').replace('- [ ] task c', '- [x] task c'));
    const list = content().querySelector('ul')!;
    assert.deepEqual(
      [...list.children].map((li) => li.textContent?.trim()),
      ['item b', 'item a', 'task c'],
    );
    assertLikeFull();
  });

  it('keeps a collapsed section collapsed and its elements', () => {
    preview.send(configMessage());
    render('# Reset\n');
    render(DOC);
    const two = content().querySelector<HTMLElement>('section[data-slug="two"]')!;
    preview.dispatch(two.querySelector('.rm-fold')!, new window.MouseEvent('click', { bubbles: true }));
    assert.ok(two.classList.contains('rm-collapsed'));
    render(DOC.replace('Second section text.', 'Second section text, edited.'));
    assert.equal(content().querySelector('section[data-slug="two"]'), two);
    assert.ok(two.classList.contains('rm-collapsed'));
    assertLikeFull();
  });

  it('renders in full when a heading changes', () => {
    const before = patchFromDoc(DOC.replace('## One A', '## One B'));
    assert.notEqual(blocks().find((b) => b.textContent === 'Intro paragraph.'), before.get('Intro paragraph.'));
    assertLikeFull();
  });

  it('renders in full when a raw HTML block changes', () => {
    const doc = `${DOC}\n<div class="note">raw</div>\n`;
    preview.send(configMessage());
    render('# Reset\n');
    render(doc);
    const intro = byText().get('Intro paragraph.');
    render(doc.replace('>raw<', '>raw, edited<'));
    assert.notEqual(byText().get('Intro paragraph.'), intro);
    assertLikeFull();
  });

  it('renders in full with change marks, and right after them', () => {
    preview.send(configMessage());
    render('# Reset\n');
    render(DOC);
    const intro = byText().get('Intro paragraph.');
    render(DOC.replace('First section text.', 'First section text, edited.'), { original: DOC });
    assert.ok(content().querySelector('.rm-chg-modified, [class*="rm-chg-"]'));
    assert.notEqual(byText().get('Intro paragraph.'), intro);
    // Next render without changes: the marked DOM is not patched, it is replaced.
    render(DOC);
    assert.equal(content().querySelector('[class*="rm-chg-"]'), null);
    assertLikeFull();
  });

  it('a render with a stray top-level text node is rendered in full', () => {
    preview.send(configMessage());
    render('# Reset\n');
    render(DOC);
    const intro = byText().get('Intro paragraph.');
    const msg = renderMessage(DOC);
    preview.send({ ...msg, html: `${msg.html}loose text`, docVersion: ++version });
    assert.notEqual(byText().get('Intro paragraph.'), intro);
    assertLikeFull();
  });
});
