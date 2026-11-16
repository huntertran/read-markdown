import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configMessage, renderMessage, usePreview } from './preview';

// Viewport-first render of long documents (webview/progressive.ts, wired in app.ts renderContent):
// the first part is shown at once, the rest after the first frame. The contract: once the rest is in,
// `#rm-content` equals a render done in one go, and nothing that happens in between (another render,
// a fold click, a scroll request) loses the rest or its collapsed sections.
//
// The one-go reference is a render with change marks against an identical original: those renders are
// never split. Not covered here (bench): how much sooner the first frame is painted.

const FIXTURE = readFileSync('test/fixtures/long-ai-doc.md', 'utf8').replace(/\r\n/g, '\n');
const BODY = FIXTURE.replace(/^---\n[\s\S]*?\n---\n/, '');
/** Long enough to be split (> 150 blocks, > 60k characters). */
const DOC = FIXTURE + Array.from({ length: 5 }, () => `\n${BODY}`).join('');
/** A heading of the last copy, far into the rest. */
const DEEP_SLUG = 'testing-strategy-5';

describe('two-part render of long documents', () => {
  const preview = usePreview();
  let version = 1;
  const content = () => preview.content;
  const blockCount = () => content().querySelectorAll('[data-line-end]').length;

  function render(markdown: string, opts: Parameters<typeof renderMessage>[1] = {}): void {
    preview.send(renderMessage(markdown, { docVersion: ++version, ...opts }));
  }

  /** Lets the first frame pass: the rest is added. */
  function finish(): void {
    preview.frames.run();
    preview.timers.run();
  }

  /** `#rm-content` after a one-go render of `markdown` (then reset to a small document). */
  function oneGo(markdown: string): { html: string; blocks: number } {
    render(markdown, { original: markdown });
    const result = { html: content().innerHTML, blocks: blockCount() };
    render('# Reset\n');
    return result;
  }

  beforeEach(() => {
    preview.send(configMessage());
    render('# Reset\n');
    // The content reaches far below the view, so the first part fills it.
    preview.layout.place(content(), 0, 100_000);
  });

  it('the test document is long enough, and the reference matches a plain render', () => {
    assert.ok(DOC.split('\n').length > 1000);
    const small = '# A\n\ntext\n\n## B\n\nmore\n';
    render(small);
    const plain = content().innerHTML;
    render('# Reset\n');
    assert.equal(oneGo(small).html, plain);
  });

  it('shows the first part at once and the rest after the first frame, like a render in one go', () => {
    const reference = oneGo(DOC);
    render(DOC);
    assert.ok(blockCount() > 0 && blockCount() < reference.blocks / 2, `first part: ${blockCount()} of ${reference.blocks} blocks`);
    assert.equal(document.getElementById(DEEP_SLUG), null);
    finish();
    assert.equal(content().innerHTML, reference.html);
  });

  it('the outline lists every heading already in the first part', () => {
    render(DOC);
    assert.ok(document.querySelector(`#rm-nav-list [data-slug="${DEEP_SLUG}"]`));
    finish();
  });

  it('keeps a collapsed section of the rest collapsed, also through a render while the rest is pending', () => {
    render(DOC);
    finish();
    const fold = document.getElementById(DEEP_SLUG)!.querySelector('.rm-fold')!;
    preview.dispatch(fold, new window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(preview.vscode.state?.collapsed, [DEEP_SLUG]);

    // A heading edit: a full render, in two parts again.
    const edited = DOC.replace('# Payment Service Refactor Plan', '# Payment Service Refactor Plan v2');
    render(edited);
    assert.equal(document.getElementById(DEEP_SLUG), null);
    // Saving while the rest is pending keeps the slugs of sections not shown yet.
    preview.dispatch(content().querySelector('.rm-fold')!, new window.MouseEvent('click', { bubbles: true }));
    const first = content().querySelector<HTMLElement>('section.rm-section')!.dataset.slug!;
    assert.deepEqual(new Set(preview.vscode.state?.collapsed), new Set([first, DEEP_SLUG]));

    // Another render before the first frame: replaces the pending rest, keeps both collapsed.
    render(edited.replace('Key goals:', 'Key goals (updated):'));
    finish();
    assert.ok(document.getElementById(DEEP_SLUG)!.closest('section')!.classList.contains('rm-collapsed'));
    assert.ok(content().querySelector(`section[data-slug="${first}"]`)!.classList.contains('rm-collapsed'));
  });

  it('a render arriving while the rest is pending ends up like that render done in one go', () => {
    const second = DOC.replace('Key goals:', 'Key goals (second):');
    const reference = oneGo(second);
    render(DOC);
    render(second);
    finish();
    assert.equal(content().innerHTML, reference.html);
  });

  it('a scroll to a line past the first part adds the rest first', () => {
    const reference = oneGo(DOC);
    render(DOC);
    const lastLine = DOC.split('\n').length - 2;
    preview.send({ type: 'scrollToLine', line: lastLine });
    assert.equal(blockCount(), reference.blocks);
    assert.equal(content().innerHTML, reference.html);
  });

  it('a highlight in the first part leaves the rest pending; a heading reveal adds it', () => {
    render(DOC);
    const part = blockCount();
    preview.send({ type: 'highlight', term: 'payment', caseSensitive: false, blockLine: 0, occurrence: 0 });
    assert.equal(blockCount(), part);
    preview.send({ type: 'revealHeading', slug: DEEP_SLUG });
    assert.ok(document.getElementById(DEEP_SLUG));
  });

  it('after the rest is in, a small edit is patched in place', () => {
    render(DOC);
    finish();
    const deep = document.getElementById(DEEP_SLUG)!;
    render(DOC.replace('Key goals:', 'Key goals, patched:'));
    assert.equal(document.getElementById(DEEP_SLUG), deep);
  });

  it('renders in one go when the first part would not fill the view', () => {
    preview.layout.place(content(), 0, 10);
    const reference = oneGo(DOC);
    preview.layout.place(content(), 0, 10);
    render(DOC);
    assert.equal(content().innerHTML, reference.html);
  });
});
