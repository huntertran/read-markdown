import * as assert from 'node:assert/strict';
import { diffDocument } from '../../src/diff/blockDiff';
import type { ToWebview } from '../../src/protocol';
import { createMarkdownRenderer } from '../../src/render/markdown';
import { acceptRender, baselineFor, resetBaseline, shouldRequestBaseline } from '../../webview/baseline';
import { applyChanges } from '../../webview/changes';
import { sanitize } from '../../webview/sanitize';
import { useDom } from './dom';

type RenderMessage = Extract<ToWebview, { type: 'render' }>;

const render = createMarkdownRenderer();
const OPTS = { mermaid: true };

const ORIGINAL = 'First paragraph stays.\n\nSecond paragraph will change a little.\n\n- one\n- two\n- three\n\nLast block goes away.\n';
const EDIT_1 = 'First paragraph stays.\n\nSecond paragraph will change quite a bit.\n\n- one\n- three\n- four\n';
const EDIT_2 = 'First paragraph stays.\n\nSecond paragraph will change a bit.\n\n- one\n- two\n- three\n\nNew tail block.\n';

/** A render message for `current` against `original`, as the extension builds it (with or without the baseline HTML). */
function message(original: string, current: string, baselineId: number, withHtml: boolean): RenderMessage {
  const before = render(original, OPTS);
  const after = render(current, OPTS);
  const ops = diffDocument(before.topBlocks, after.topBlocks);
  assert.ok(ops?.length);
  return {
    type: 'render',
    html: after.html,
    headings: [],
    hasMermaid: false,
    docVersion: 1,
    changes: withHtml ? { baselineId, originalHtml: before.html, ops } : { baselineId, ops },
  };
}

/** What `main.ts` does with a message: store the baseline on arrival, then apply the changes if it is there. */
function show(msg: RenderMessage, mode: 'inline' | 'gutter' = 'inline'): { root: HTMLElement; missing: boolean } {
  const accepted = acceptRender(msg);
  const root = document.createElement('div');
  root.replaceChildren(sanitize(accepted.html));
  const baseline = accepted.changes && baselineFor(accepted.changes.baselineId);
  if (accepted.changes && baseline) applyChanges(root, accepted.changes.ops, baseline, mode);
  return { root, missing: accepted.changes !== undefined && !baseline };
}

describe('baseline cache (webview)', () => {
  useDom();
  beforeEach(resetBaseline);

  it('a full message followed by an id-only one renders the same DOM as two full messages', () => {
    for (const mode of ['inline', 'gutter'] as const) {
      resetBaseline();
      show(message(ORIGINAL, EDIT_1, 1, true), mode);
      const cached = show(message(ORIGINAL, EDIT_2, 1, false), mode);
      resetBaseline();
      show(message(ORIGINAL, EDIT_1, 1, true), mode);
      const full = show(message(ORIGINAL, EDIT_2, 1, true), mode);
      assert.equal(cached.missing, false);
      assert.ok(cached.root.querySelector('.rm-chg-mod, .rm-chg-ins, .rm-chg-del'), 'changes are shown');
      assert.equal(cached.root.innerHTML, full.root.innerHTML, mode);
    }
  });

  it('does not change the cached baseline while applying changes to it', () => {
    show(message(ORIGINAL, EDIT_1, 1, true));
    const before = [...(baselineFor(1)?.values() ?? [])].map((el) => el.outerHTML);
    assert.ok(before.length > 0);
    const first = show(message(ORIGINAL, EDIT_1, 1, false));
    const second = show(message(ORIGINAL, EDIT_1, 1, false));
    assert.equal(first.root.innerHTML, second.root.innerHTML);
    assert.deepEqual([...(baselineFor(1)?.values() ?? [])].map((el) => el.outerHTML), before);
  });

  it('an unknown id has no baseline: no marks, and it is requested once', () => {
    const result = show(message(ORIGINAL, EDIT_1, 5, false));
    assert.equal(result.missing, true);
    assert.equal(result.root.querySelector('.rm-chg-ins, .rm-chg-mod, .rm-chg-del, ins, del'), null);
    assert.equal(baselineFor(5), undefined);
    assert.equal(shouldRequestBaseline(5), true);
    assert.equal(shouldRequestBaseline(5), false);
    // Still missing, still no second request: the safety net cannot loop.
    show(message(ORIGINAL, EDIT_1, 5, false));
    assert.equal(shouldRequestBaseline(5), false);
    // The re-sent render brings the HTML.
    const resent = show(message(ORIGINAL, EDIT_1, 5, true));
    assert.equal(resent.missing, false);
    assert.ok(resent.root.querySelector('.rm-chg-mod, .rm-chg-ins, .rm-chg-del'));
    const later = show(message(ORIGINAL, EDIT_2, 5, false));
    assert.equal(later.missing, false);
  });

  it('a stale id does not match a newer baseline', () => {
    show(message(ORIGINAL, EDIT_1, 2, true));
    assert.equal(show(message(ORIGINAL, EDIT_1, 1, false)).missing, true);
  });

  it('a new baseline replaces the old one', () => {
    show(message(ORIGINAL, EDIT_1, 1, true));
    assert.ok(baselineFor(1));
    show(message(EDIT_2, EDIT_1, 2, true));
    assert.equal(baselineFor(1), undefined);
    assert.ok(baselineFor(2));
  });

  it('marks against the new baseline after a replacement', () => {
    show(message(ORIGINAL, EDIT_1, 1, true));
    const replaced = show(message(EDIT_1, EDIT_2, 2, true));
    resetBaseline();
    const fresh = show(message(EDIT_1, EDIT_2, 2, true));
    assert.equal(replaced.root.innerHTML, fresh.root.innerHTML);
  });

  it('stores the baseline when a message arrives, even if a later one is the one applied', () => {
    // A block editor is open: the first render (with the HTML) is held back and replaced by the next (id only).
    const held = acceptRender(message(ORIGINAL, EDIT_1, 3, true));
    const latest = message(ORIGINAL, EDIT_2, 3, false);
    assert.equal(held.changes?.originalHtml, undefined);
    // Only the latest message is applied when the editor closes.
    const applied = show(latest);
    assert.equal(applied.missing, false);
    assert.ok(applied.root.querySelector('.rm-chg-mod, .rm-chg-ins, .rm-chg-del'));
  });

  it('re-rendering a kept message (config change, mode toggle) finds its baseline again', () => {
    const kept = acceptRender(message(ORIGINAL, EDIT_1, 1, true));
    for (const mode of ['inline', 'gutter', 'inline'] as const) {
      const root = document.createElement('div');
      root.replaceChildren(sanitize(kept.html));
      const baseline = kept.changes && baselineFor(kept.changes.baselineId);
      assert.ok(baseline);
      applyChanges(root, kept.changes?.ops ?? [], baseline, mode);
      assert.ok(root.querySelector('.rm-chg-mod, .rm-chg-ins, .rm-chg-del'), mode);
    }
  });

  it('releases the baseline when a render arrives without changes', () => {
    show(message(ORIGINAL, EDIT_1, 1, true));
    acceptRender({ type: 'render', html: '<p>x</p>', headings: [], hasMermaid: false, docVersion: 2 });
    assert.equal(baselineFor(1), undefined);
    // The extension forgets it too, so the next render with changes carries the HTML again.
    assert.equal(show(message(ORIGINAL, EDIT_1, 1, true)).missing, false);
  });

  it('removes originalHtml from the message it hands on', () => {
    const msg = message(ORIGINAL, EDIT_1, 1, true);
    const accepted = acceptRender(msg);
    assert.equal(accepted.changes?.originalHtml, undefined);
    assert.equal(accepted.changes?.baselineId, 1);
    assert.deepEqual(accepted.changes?.ops, msg.changes?.ops);
    assert.equal(accepted.html, msg.html);
  });
});
