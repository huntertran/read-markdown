import * as assert from 'node:assert/strict';
import { useDom } from './dom';
import { useLayout } from './layout';

// scroll.ts registers window listeners at import time and keeps module-level state (suppression
// window, anchor line, last user input, pointer state, last width, line map cache), so it is loaded
// after useDom() and the stubs exist. The state is shared by the tests of this file; `beforeEach`
// brings it to a known point through the public API and the fake clock (see `resetModule`).
type Scroll = typeof import('../../webview/scroll');

describe('scroll sync guards', () => {
  useDom();
  const layout = useLayout();

  let scroll: Scroll;
  /** Observed in the import hook, before any test (and so any input or scroll) could touch the module. */
  let initial: { sinceInput: number; suppressed: boolean; scrollsOnFirstResize: number };
  let invalidationsA = 0;
  let invalidationsB = 0;

  before(async () => {
    scroll = await import('../../webview/scroll');
    initial = { sinceInput: scroll.msSinceUserInput(), suppressed: scroll.isSuppressed(), scrollsOnFirstResize: -1 };

    // The very first width the observer reports is not a "change", whatever the scroll position.
    const first = block(0, 50);
    layout.scrollY = 100;
    scroll.initScrollMap(first.parentElement!);
    layout.resize(300, first.parentElement!);
    initial.scrollsOnFirstResize = layout.scrolls.length;

    scroll.onInvalidate(() => invalidationsA++);
    scroll.onInvalidate(() => invalidationsB++);
  });

  beforeEach(() => {
    // Every window in the module is shorter than this: suppression (100 ms), anchor hold (150 ms),
    // user input (800 ms).
    layout.advance(1_000_000);
    window.dispatchEvent(new window.Event('blur')); // releases a pointer held by an earlier test
    scroll.initScrollMap(document.createElement('div'));
    scroll.invalidate();
    scroll.scrollToLine(0); // anchor back to line 0
    layout.advance(1_000);
    layout.scrollY = 0;
    layout.scrolls.length = 0;
  });

  // ---- helpers ------------------------------------------------------------------------------

  /** A `<p data-line>` inside a fresh root (attached to the body), at an absolute `top`. */
  function block(line: number | string, top: number | undefined): HTMLElement {
    const root = document.createElement('div');
    document.body.append(root);
    return addBlock(root, line, top);
  }

  function addBlock(root: HTMLElement, line: number | string, top: number | undefined): HTMLElement {
    const p = document.createElement('p');
    p.dataset.line = String(line);
    layout.place(p, top);
    root.append(p);
    return p;
  }

  /** Initializes the map on a root holding blocks at `[line, top]` and returns the root. */
  function page(blocks: [line: number | string, top: number | undefined][]): HTMLElement {
    const root = document.createElement('div');
    document.body.append(root);
    for (const [line, top] of blocks) addBlock(root, line, top);
    scroll.initScrollMap(root);
    scroll.invalidate();
    return root;
  }

  /** Lines 0, 10, 20 at tops 0, 100, 300: 10 lines per 100px, then 10 lines per 200px. */
  const STANDARD: [number, number][] = [
    [0, 0],
    [10, 100],
    [20, 300],
  ];

  const fire = (type: string): void => {
    document.body.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  };

  /** Establishes a known last width on `root`, then forgets the scrolls this caused. */
  function prime(root: HTMLElement, width = 500): void {
    layout.scrollY = 0;
    layout.resize(width, root);
    layout.scrolls.length = 0;
  }

  /** The `top` of the most recent programmatic scroll, from the recorded calls. */
  const lastScroll = (): number | undefined => layout.scrolls.at(-1)?.top;

  // ---- suppression and user input ----------------------------------------------------------

  describe('suppression window', () => {
    it('starts out suppressed and idle: no input has happened yet', () => {
      assert.equal(initial.sinceInput, Infinity);
      assert.equal(initial.suppressed, true);
    });

    it('scrollProgrammatically scrolls instantly to y', () => {
      scroll.scrollProgrammatically(250);
      assert.deepEqual(layout.scrolls, [{ top: 250, behavior: 'instant' }]);
      assert.equal(layout.scrollY, 250);
    });

    it('scrollProgrammatically clamps a negative position to 0', () => {
      scroll.scrollProgrammatically(-30);
      assert.deepEqual(layout.scrolls, [{ top: 0, behavior: 'instant' }]);
    });

    it('is suppressed right after a programmatic scroll', () => {
      scroll.scrollProgrammatically(250);
      assert.equal(scroll.isSuppressed(), true);
    });

    it('the window lasts 100 ms: 99 ms in it is still inside, at 100 ms it is over (reader recently active)', () => {
      scroll.markUserScroll();
      layout.advance(10);
      scroll.scrollProgrammatically(250);
      assert.equal(scroll.isSuppressed(), true);
      layout.advance(99);
      assert.equal(scroll.isSuppressed(), true, 'just inside the window: user input does not end it');
      layout.advance(1);
      assert.equal(scroll.isSuppressed(), false, 'window over, the user input is recent: scroll is the reader`s');
    });

    it('user input during the window does not end the suppression early', () => {
      scroll.scrollProgrammatically(250);
      layout.advance(50);
      scroll.markUserScroll();
      fire('wheel');
      assert.equal(scroll.isSuppressed(), true);
      layout.advance(49);
      assert.equal(scroll.isSuppressed(), true, 'still inside the window');
      layout.advance(1);
      assert.equal(scroll.isSuppressed(), false, 'the input from 50 ms ago now counts');
    });

    it('a pointer held down during the window does not end the suppression early either', () => {
      scroll.scrollProgrammatically(250);
      fire('pointerdown');
      assert.equal(scroll.isSuppressed(), true);
      layout.advance(100);
      assert.equal(scroll.isSuppressed(), false);
    });

    it('a second programmatic scroll restarts the window', () => {
      scroll.markUserScroll();
      scroll.scrollProgrammatically(100);
      layout.advance(60);
      scroll.scrollProgrammatically(200);
      layout.advance(60);
      assert.equal(scroll.isSuppressed(), true, '120 ms after the first, 60 after the second');
      layout.advance(40);
      assert.equal(scroll.isSuppressed(), false);
    });

    it('scrollToLine suppresses like scrollProgrammatically', () => {
      page(STANDARD);
      scroll.markUserScroll();
      scroll.scrollToLine(10);
      assert.equal(scroll.isSuppressed(), true);
      layout.advance(100);
      assert.equal(scroll.isSuppressed(), false);
    });
  });

  describe('user input', () => {
    it('markUserScroll: the next scroll is the reader`s, for 800 ms', () => {
      assert.equal(scroll.isSuppressed(), true, 'idle before');
      scroll.markUserScroll();
      assert.equal(scroll.isSuppressed(), false);
      layout.advance(799);
      assert.equal(scroll.isSuppressed(), false, 'just inside the window');
      layout.advance(1);
      assert.equal(scroll.isSuppressed(), false, 'exactly 800 ms: the window is inclusive');
      layout.advance(1);
      assert.equal(scroll.isSuppressed(), true, '801 ms: over');
    });

    it('msSinceUserInput is 0 right after input and follows the clock', () => {
      scroll.markUserScroll();
      assert.equal(scroll.msSinceUserInput(), 0);
      layout.advance(1234);
      assert.equal(scroll.msSinceUserInput(), 1234);
      layout.advance(1);
      assert.equal(scroll.msSinceUserInput(), 1235);
    });

    it('new input restarts the count', () => {
      scroll.markUserScroll();
      layout.advance(700);
      scroll.markUserScroll();
      layout.advance(700);
      assert.equal(scroll.msSinceUserInput(), 700);
      assert.equal(scroll.isSuppressed(), false);
    });

    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown', 'pointerup']) {
      it(`a ${type} event counts as user input`, () => {
        assert.ok(scroll.msSinceUserInput() > 800, 'idle before');
        fire(type);
        if (type === 'pointerdown') window.dispatchEvent(new window.Event('blur')); // do not hold the pointer
        assert.equal(scroll.msSinceUserInput(), 0);
        assert.equal(scroll.isSuppressed(), false);
        layout.advance(5);
        assert.equal(scroll.msSinceUserInput(), 5);
      });
    }

    it('events that are not input (scroll, mousemove, focus) do not count', () => {
      for (const type of ['scroll', 'mousemove', 'focus', 'keyup', 'click']) fire(type);
      window.dispatchEvent(new window.Event('scroll'));
      assert.ok(scroll.msSinceUserInput() >= 1_000);
      assert.equal(scroll.isSuppressed(), true);
    });

    it('input is seen in the capture phase even if a handler stops propagation', () => {
      const inner = document.createElement('div');
      inner.addEventListener('wheel', (e) => e.stopPropagation());
      document.body.append(inner);
      inner.dispatchEvent(new window.Event('wheel', { bubbles: true }));
      assert.equal(scroll.msSinceUserInput(), 0);
    });
  });

  describe('pointer held down', () => {
    it('keeps scrolls user-initiated and the reader "active" however long the press lasts', () => {
      fire('pointerdown');
      assert.equal(scroll.msSinceUserInput(), 0);
      assert.equal(scroll.isSuppressed(), false);
      layout.advance(60_000);
      assert.equal(scroll.msSinceUserInput(), 0, 'dragging the scrollbar for a minute');
      assert.equal(scroll.isSuppressed(), false);
    });

    it('pointerup releases it and counts as input at that moment', () => {
      fire('pointerdown');
      layout.advance(5_000);
      fire('pointerup');
      assert.equal(scroll.msSinceUserInput(), 0);
      layout.advance(800);
      assert.equal(scroll.isSuppressed(), false);
      layout.advance(1);
      assert.equal(scroll.isSuppressed(), true);
      assert.equal(scroll.msSinceUserInput(), 801);
    });

    it('window blur releases it without counting as input (a release outside the window is never seen)', () => {
      fire('pointerdown');
      layout.advance(5_000);
      window.dispatchEvent(new window.Event('blur'));
      assert.equal(scroll.msSinceUserInput(), 5_000, 'measured from the pointerdown');
      assert.equal(scroll.isSuppressed(), true);
    });
  });

  // ---- data-line <-> scrollY map -------------------------------------------------------------

  describe('line map', () => {
    it('lineAtTop is 0 at the top of the page', () => {
      page(STANDARD);
      assert.equal(scroll.lineAtTop(), 0);
    });

    it('interpolates between two blocks', () => {
      page(STANDARD);
      layout.scrollY = 50;
      assert.equal(scroll.lineAtTop(), 5);
      layout.scrollY = 200;
      assert.equal(scroll.lineAtTop(), 15, 'second span: 100px of 200 = half of 10 lines');
    });

    it('is exactly the block line when a block is at the top', () => {
      page(STANDARD);
      layout.scrollY = 100;
      assert.equal(scroll.lineAtTop(), 10);
      layout.scrollY = 300;
      assert.equal(scroll.lineAtTop(), 20);
    });

    it('is the last block line after the last block (no extrapolation)', () => {
      page(STANDARD);
      layout.scrollY = 5_000;
      assert.equal(scroll.lineAtTop(), 20);
    });

    it('is the first block line while scrolled above the first block', () => {
      page([
        [3, 50],
        [13, 150],
      ]);
      layout.scrollY = 20;
      assert.equal(scroll.lineAtTop(), 3);
      layout.scrollY = 0;
      assert.equal(scroll.lineAtTop(), 0, 'at the very top it is 0, not the first block line');
    });

    it('is 0 for an empty document, also when scrolled', () => {
      page([]);
      layout.scrollY = 300;
      assert.equal(scroll.lineAtTop(), 0);
    });

    it('stores absolute positions: a map built while scrolled still answers for other offsets', () => {
      page(STANDARD);
      layout.scrollY = 120;
      assert.equal(scroll.lineAtTop(), 11, 'built at scrollY 120 (rect tops are relative to the viewport)');
      layout.scrollY = 200;
      assert.equal(scroll.lineAtTop(), 15);
    });

    it('skips blocks without client rects (hidden in a collapsed section)', () => {
      page([
        [0, 0],
        [5, undefined],
        [10, 100],
      ]);
      layout.scrollY = 50;
      assert.equal(scroll.lineAtTop(), 5, 'interpolated between line 0 and line 10; line 5 is hidden');
      scroll.scrollToLine(5);
      assert.equal(lastScroll(), 50);
    });

    it('skips blocks whose line does not increase, whose line is not a number, or that sit above the previous one', () => {
      page([
        [0, 0],
        [10, 100],
        [10, 150], // duplicate line
        [4, 200], // line goes back
        ['x', 250], // not a number
        [12, 50], // top above the previous entry
        [20, 300],
      ]);
      layout.scrollY = 200;
      assert.equal(scroll.lineAtTop(), 15, 'only 0@0, 10@100, 20@300 count');
    });

    it('includes nested blocks, in document order', () => {
      const root = page([[0, 0]]);
      const inner = document.createElement('div');
      root.append(inner);
      addBlock(inner, 8, 80);
      addBlock(root, 20, 200);
      scroll.invalidate();
      layout.scrollY = 80;
      assert.equal(scroll.lineAtTop(), 8);
    });

    describe('scrollToLine', () => {
      it('scrolls to the interpolated position', () => {
        page(STANDARD);
        scroll.scrollToLine(5);
        assert.equal(lastScroll(), 50);
        scroll.scrollToLine(15);
        assert.equal(lastScroll(), 200);
      });

      it('scrolls to a block top for the line of a block', () => {
        page(STANDARD);
        scroll.scrollToLine(10);
        assert.equal(lastScroll(), 100);
      });

      it('scrolls to the top for line 0 and below', () => {
        page(STANDARD);
        layout.scrollY = 150;
        scroll.scrollToLine(0);
        assert.equal(lastScroll(), 0);
        scroll.scrollToLine(-4);
        assert.equal(lastScroll(), 0);
      });

      it('scrolls to the first block for a line before it', () => {
        page([
          [3, 50],
          [13, 150],
        ]);
        scroll.scrollToLine(1);
        assert.equal(lastScroll(), 50);
      });

      it('scrolls to the last block for a line after it', () => {
        page(STANDARD);
        scroll.scrollToLine(25);
        assert.equal(lastScroll(), 300);
        scroll.scrollToLine(20);
        assert.equal(lastScroll(), 300);
      });

      it('does not scroll for an empty document', () => {
        page([]);
        scroll.markUserScroll();
        scroll.scrollToLine(7);
        assert.deepEqual(layout.scrolls, []);
        assert.equal(scroll.isSuppressed(), false, 'no programmatic scroll happened, so no suppression window either');
      });

      it('round trips with lineAtTop', () => {
        page(STANDARD);
        for (const line of [0, 2.5, 10, 12, 19.5, 20]) {
          scroll.scrollToLine(line);
          assert.ok(Math.abs(scroll.lineAtTop() - line) < 1e-9, `line ${line}`);
        }
      });
    });

    describe('invalidate', () => {
      it('drops the cache: a changed layout is only seen afterwards', () => {
        const root = page(STANDARD);
        layout.scrollY = 50;
        assert.equal(scroll.lineAtTop(), 5);
        const blocks = [...root.children] as HTMLElement[];
        layout.place(blocks[1], 400);
        layout.place(blocks[2], 800);
        assert.equal(scroll.lineAtTop(), 5, 'cached');
        scroll.scrollToLine(10);
        assert.equal(lastScroll(), 100, 'scrollToLine uses the cache too');
        scroll.invalidate();
        layout.scrollY = 200;
        assert.equal(scroll.lineAtTop(), 5);
        scroll.scrollToLine(10);
        assert.equal(lastScroll(), 400);
      });

      it('picks up newly hidden blocks', () => {
        const root = page(STANDARD);
        assert.equal(scroll.lineAtTop(), 0);
        layout.place(root.children[1] as HTMLElement, undefined);
        scroll.invalidate();
        layout.scrollY = 150;
        assert.equal(scroll.lineAtTop(), 10, 'half way between line 0@0 and line 20@300 (with line 10 still mapped it would be 12.5)');
      });

      it('runs every onInvalidate listener, once per call', () => {
        const a = invalidationsA;
        const b = invalidationsB;
        scroll.invalidate();
        assert.equal(invalidationsA, a + 1);
        assert.equal(invalidationsB, b + 1);
        scroll.invalidate();
        scroll.invalidate();
        assert.equal(invalidationsA, a + 3);
        assert.equal(invalidationsB, b + 3);
      });

      it('runs after the cache is dropped, so a listener sees the new layout', () => {
        const root = page(STANDARD);
        assert.equal(scroll.lineAtTop(), 0);
        layout.place(root.children[1] as HTMLElement, 500);
        let armed = true;
        let seen: number | undefined;
        scroll.onInvalidate(() => {
          if (!armed) return; // listeners cannot be removed: keep this one inert for later tests
          layout.scrollY = 250;
          seen = scroll.lineAtTop();
        });
        scroll.invalidate();
        armed = false;
        assert.equal(seen, 5, '250px on the new layout (line 10 at 500px) is line 5; the old layout would say 12.5');
      });
    });
  });

  // ---- anchor ------------------------------------------------------------------------------------

  describe('anchor', () => {
    it('the very first observed width is not a change', () => {
      assert.equal(initial.scrollsOnFirstResize, 0);
    });

    it('re-scrolls to the anchor line after a width change, on the new layout, suppressed', () => {
      const root = page(STANDARD);
      prime(root);
      layout.scrollY = 50;
      scroll.updateAnchor();
      // Narrower: everything moves down.
      const blocks = [...root.children] as HTMLElement[];
      layout.place(blocks[1], 200);
      layout.place(blocks[2], 600);
      layout.resize(400, root);
      assert.deepEqual(layout.scrolls, [{ top: 100, behavior: 'instant' }], 'line 5 is now at 100px');
      assert.equal(scroll.isSuppressed(), true, 'not echoed to the editor');
    });

    it('does not re-scroll when the width is the same', () => {
      const root = page(STANDARD);
      prime(root);
      layout.scrollY = 50;
      scroll.updateAnchor();
      layout.resize(500, root);
      assert.deepEqual(layout.scrolls, []);
    });

    it('treats a change below 0.5px as no change and 0.5px as a change', () => {
      const root = page(STANDARD);
      prime(root);
      layout.scrollY = 50;
      scroll.updateAnchor();
      layout.resize(500.4, root);
      assert.deepEqual(layout.scrolls, [], '0.4px: no change');
      layout.resize(500.5, root); // 0.1px from the last width: still none; the last width is now 500.4
      assert.deepEqual(layout.scrolls, []);
      layout.resize(501, root); // 0.5px from 500.5
      assert.equal(layout.scrolls.length, 1);
    });

    it('compares against the last observed width, not against the first', () => {
      const root = page(STANDARD);
      prime(root, 500);
      layout.scrollY = 50;
      scroll.updateAnchor();
      layout.resize(300, root);
      assert.equal(layout.scrolls.length, 1);
      layout.scrollY = 50;
      layout.resize(300, root);
      assert.equal(layout.scrolls.length, 1, 'same as the last width');
      layout.resize(500, root);
      assert.equal(layout.scrolls.length, 2, 'different from the last width, even though equal to the first');
    });

    it('does not re-scroll at the top of the page (scrollY 0)', () => {
      const root = page(STANDARD);
      prime(root);
      layout.resize(300, root);
      assert.deepEqual(layout.scrolls, []);
    });

    it('rebuilds the map on every resize, even without a width change', () => {
      const root = page(STANDARD);
      prime(root);
      layout.place(root.children[1] as HTMLElement, 400);
      layout.place(root.children[2] as HTMLElement, 800);
      layout.resize(500, root);
      layout.scrollY = 200;
      assert.equal(scroll.lineAtTop(), 5);
      assert.deepEqual(layout.scrolls, []);
    });

    it('updateAnchor records the line at the top, fractional', () => {
      const root = page(STANDARD);
      prime(root);
      layout.scrollY = 200;
      scroll.updateAnchor();
      layout.resize(300, root);
      assert.equal(lastScroll(), 200, 'line 15, back at 200px on the unchanged layout');
    });

    it('scrollToLine remembers its line even when the document is empty', () => {
      const root = page([]);
      prime(root);
      scroll.scrollToLine(7);
      assert.deepEqual(layout.scrolls, []);
      addBlock(root, 0, 0);
      addBlock(root, 10, 100);
      layout.scrollY = 10;
      layout.resize(300, root);
      assert.equal(lastScroll(), 70);
    });

    it('updateAnchor with nothing in the document anchors at line 0', () => {
      const root = page([]);
      prime(root);
      scroll.scrollToLine(7);
      layout.advance(150);
      layout.scrollY = 10;
      scroll.updateAnchor();
      addBlock(root, 0, 0);
      addBlock(root, 10, 100);
      layout.resize(300, root);
      assert.equal(lastScroll(), 0);
    });

    describe('hold window', () => {
      /** The y the next reflow scrolls to, i.e. the anchor line's position (STANDARD: line 3 = 30, line 10 = 100). */
      let probeWidth = 700;
      function anchorY(root: HTMLElement): number | undefined {
        layout.scrollY = 30; // anything above 0: the reflow only re-scrolls when scrolled
        layout.scrolls.length = 0;
        layout.resize((probeWidth += 10), root); // a new width every time
        return lastScroll();
      }

      function setup(): HTMLElement {
        const root = page(STANDARD);
        prime(root);
        scroll.scrollToLine(10); // anchor 10, hold 150 ms; the stubbed scrollTo moves to 100
        assert.equal(layout.scrollY, 100);
        layout.scrollY = 30; // the scroll event of that scroll, or a scroll-anchoring shift
        return root;
      }

      it('scrollToLine keeps the anchor from being overwritten for 150 ms: just inside', () => {
        const root = setup();
        layout.advance(149);
        scroll.updateAnchor();
        assert.equal(anchorY(root), 100, 'still line 10');
      });

      it('and lets updateAnchor record again from 150 ms on: just outside', () => {
        const root = setup();
        layout.advance(150);
        scroll.updateAnchor();
        assert.equal(anchorY(root), 30, 'line 3 at scrollY 30');
      });

      it('scrollToLine always sets the anchor, also inside an earlier hold window', () => {
        const root = setup();
        layout.advance(10);
        scroll.scrollToLine(20);
        layout.scrollY = 30;
        layout.advance(149);
        scroll.updateAnchor();
        assert.equal(anchorY(root), 300);
      });

      it('a reflow scroll starts a new hold window', () => {
        const root = setup();
        layout.advance(1_000);
        scroll.updateAnchor(); // anchor 3
        layout.scrollY = 30;
        layout.resize(333, root); // reflow: scrollToLine(3), hold again
        layout.scrollY = 90;
        layout.advance(149);
        scroll.updateAnchor();
        assert.equal(anchorY(root), 30, 'still line 3, not line 9');
      });
    });
  });
});
