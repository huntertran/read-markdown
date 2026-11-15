import * as assert from 'node:assert/strict';
import { useDom } from './dom';

// webview/scroll.ts (imported by changeGutter) registers `window` listeners at import time, so the
// module is loaded in `before`, once `useDom` has installed the window.
let collectMovePairs: typeof import('../../webview/changeGutter').collectMovePairs;

/** The lookup `updateChangeGutter` / `moveArrows` used before the map: first match in document order. */
function queryEnd(root: Element, id: string, side: 'from' | 'to'): Element | null {
  // Test ids are plain, so no CSS.escape (the DOM globals do not include it).
  return root.querySelector(`[data-move-id="${id}"].rm-chg-move-${side}`);
}

const FIXTURE = `
  <p class="rm-chg-move-from" data-move-id="b1" id="b1-from">one</p>
  <p class="rm-chg-move-from" data-move-id="b2" id="b2-from">two</p>
  <p class="rm-chg-move-to" data-move-id="b2" id="b2-to">two</p>
  <p class="rm-chg-move-to" data-move-id="b1" id="b1-to">one</p>
  <p class="rm-chg-move-to" data-move-id="b3" id="b3-to">only the new end</p>
  <p class="rm-chg-move-from" data-move-id="b4" id="b4-from">only the old end</p>
  <p class="rm-chg-mod">no move id</p>
  <ul class="rm-chg-move-to" data-move-id="n1" id="n1-to">
    <li class="rm-chg-move-to" data-move-id="n2" id="n2-to">nested</li>
    <li class="rm-chg-move-from" data-move-id="n2" id="n2-from">nested</li>
  </ul>
  <li class="rm-chg-move-from" data-move-id="n1" id="n1-from">outer</li>
  <p class="rm-chg-move-from" data-move-id="d" id="d-from-1">dup</p>
  <p class="rm-chg-move-from" data-move-id="d" id="d-from-2">dup</p>
  <p class="rm-chg-move-to" data-move-id="d" id="d-to-1">dup</p>
  <p class="rm-chg-move-to" data-move-id="d" id="d-to-2">dup</p>
  <p class="rm-chg-move-to" data-move-id="d" id="d-to-3">dup</p>
  <p class="rm-chg-move-to rm-chg-move-from" data-move-id="both" id="both">both classes</p>
`;

describe('changeGutter', () => {
  useDom();

  before(async () => {
    ({ collectMovePairs } = await import('../../webview/changeGutter'));
  });

  describe('collectMovePairs', () => {
    function root(): HTMLElement {
      const el = document.createElement('div');
      el.innerHTML = FIXTURE;
      document.body.append(el);
      return el;
    }

    it('finds both ends of every move', () => {
      const pairs = collectMovePairs(root());
      assert.equal(pairs.get('b1')?.from?.id, 'b1-from');
      assert.equal(pairs.get('b1')?.to?.id, 'b1-to');
      assert.equal(pairs.get('b2')?.from?.id, 'b2-from');
      assert.equal(pairs.get('b2')?.to?.id, 'b2-to');
      assert.equal(pairs.get('n2')?.from?.id, 'n2-from');
      assert.equal(pairs.get('n2')?.to?.id, 'n2-to');
    });

    it('has one end only for a lone move id', () => {
      const pairs = collectMovePairs(root());
      assert.equal(pairs.get('b3')?.to?.id, 'b3-to');
      assert.equal(pairs.get('b3')?.from, undefined);
      assert.equal(pairs.get('b4')?.from?.id, 'b4-from');
      assert.equal(pairs.get('b4')?.to, undefined);
    });

    it('takes the first element in document order when an id repeats', () => {
      const pairs = collectMovePairs(root());
      assert.equal(pairs.get('d')?.from?.id, 'd-from-1');
      assert.equal(pairs.get('d')?.to?.id, 'd-to-1');
    });

    it('counts an element with both classes as both ends', () => {
      const pairs = collectMovePairs(root());
      assert.equal(pairs.get('both')?.from?.id, 'both');
      assert.equal(pairs.get('both')?.to?.id, 'both');
    });

    it('ignores elements without a move id', () => {
      const pairs = collectMovePairs(root());
      assert.equal(pairs.has(''), false);
      assert.equal(pairs.size, 8);
    });

    it('gives the same partners as the per-element query for every id', () => {
      const r = root();
      const pairs = collectMovePairs(r);
      const ids = new Set([...r.querySelectorAll<HTMLElement>('[data-move-id]')].map((e) => e.dataset.moveId!));
      assert.equal(ids.size, pairs.size);
      for (const id of ids) {
        assert.equal(pairs.get(id)?.from ?? null, queryEnd(r, id, 'from'), `${id} from`);
        assert.equal(pairs.get(id)?.to ?? null, queryEnd(r, id, 'to'), `${id} to`);
      }
    });

    it('does not keep elements of an earlier render', () => {
      const r = root();
      const before = collectMovePairs(r);
      r.innerHTML = FIXTURE;
      const after = collectMovePairs(r);
      assert.notEqual(after.get('b1')?.from, before.get('b1')?.from);
      assert.ok(r.contains(after.get('b1')?.from ?? null));
    });
  });
});
