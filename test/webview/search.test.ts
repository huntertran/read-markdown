import * as assert from 'node:assert/strict';
import { buildTextIndex, findMatches } from '../../webview/searchIndex';
import { useDom } from './dom';
import { useLayout } from './layout';

type SearchModule = typeof import('../../webview/search');
type SearchRequest = import('../../webview/search').SearchRequest;

/** Stand-in for the CSS Custom Highlight API's `Highlight`: remembers its ranges. */
class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

describe('search', () => {
  useDom();
  const layout = useLayout();
  let mod: SearchModule;
  /** The registry behind the stubbed `CSS.highlights`. */
  const registry = new Map<string, FakeHighlight>();
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let rangeRect = { top: 100, bottom: 120 };
  let hadRangeRect = false;
  // `useDom` removes the globals in its own `after`, which runs before ours (mocha runs `after` hooks in registration order).
  let rangeProto: Record<string, unknown> | undefined;

  function stubGlobal(name: string, value: unknown): void {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  before(async () => {
    // `search.ts` decides at import time whether the Highlight API exists, so the stubs come first.
    stubGlobal('CSS', { highlights: registry });
    stubGlobal('Highlight', FakeHighlight);
    // jsdom's Range has no layout.
    const proto = Range.prototype as unknown as Record<string, unknown>;
    rangeProto = proto;
    hadRangeRect = 'getBoundingClientRect' in proto;
    proto.getBoundingClientRect = () => ({ ...rangeRect, left: 0, right: 0, x: 0, y: rangeRect.top, width: 0, height: rangeRect.bottom - rangeRect.top });
    mod = await import('../../webview/search');
  });

  after(() => {
    if (!hadRangeRect) delete rangeProto?.getBoundingClientRect;
    for (const [name, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    saved.clear();
  });

  beforeEach(() => {
    registry.clear();
    rangeRect = { top: 100, bottom: 120 };
  });

  function page(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.append(root);
    return root;
  }
  const matches = (root: HTMLElement, term: string, caseSensitive = false): Range[] => findMatches(buildTextIndex(root), term, caseSensitive);
  const req = (blockLine: number, occurrence = 0, term = 'foo'): SearchRequest => ({ term, caseSensitive: false, blockLine, occurrence });
  /** The `data-line` of the innermost marked element around a range, for readable assertions. */
  const lineOfRange = (r: Range): string | undefined => (r.startContainer.parentElement?.closest<HTMLElement>('[data-line]'))?.dataset.line;

  describe('pickCurrent', () => {
    // Matches in document order: 0 = h1 (line 0), 1 and 2 = both in the paragraph at line 2, 3 = paragraph at line 4.
    const DOC = '<h1 data-line="0">foo</h1><p data-line="2">foo and foo</p><p data-line="4">foo</p>';

    it('picks the occurrence inside the block that starts at the requested line', () => {
      const root = page(DOC);
      const ranges = matches(root, 'foo');
      assert.equal(ranges.length, 4);
      assert.equal(mod.pickCurrent(root, ranges, req(0)), 0);
      assert.equal(mod.pickCurrent(root, ranges, req(2, 0)), 1);
      assert.equal(mod.pickCurrent(root, ranges, req(2, 1)), 2);
      assert.equal(mod.pickCurrent(root, ranges, req(4, 0)), 3);
    });

    it('clamps an occurrence index beyond the matches of the block to its last match', () => {
      const root = page(DOC);
      const ranges = matches(root, 'foo');
      assert.equal(mod.pickCurrent(root, ranges, req(2, 2)), 2);
      assert.equal(mod.pickCurrent(root, ranges, req(2, 99)), 2);
      assert.equal(mod.pickCurrent(root, ranges, req(0, 5)), 0);
    });

    it('falls back to the match whose block is nearest when no element starts at the line', () => {
      const root = page(DOC);
      const ranges = matches(root, 'foo');
      assert.equal(mod.pickCurrent(root, ranges, req(5)), 3); // 4 is nearest
      assert.equal(mod.pickCurrent(root, ranges, req(100)), 3);
      assert.equal(mod.pickCurrent(root, ranges, req(-3)), 0);
      assert.equal(mod.pickCurrent(root, ranges, req(1, 7)), 0); // lines 0 and 2 are equally near: see the tie test
    });

    it('prefers the earlier match when two blocks are equally near (strict comparison, document order)', () => {
      const root = page(DOC);
      const ranges = matches(root, 'foo');
      // Line 3 is one line after the paragraph at 2 and one before the paragraph at 4.
      assert.equal(mod.pickCurrent(root, ranges, req(3)), 1);
      // Two matches in one block are at the same distance: the first of them.
      assert.equal(lineOfRange(ranges[mod.pickCurrent(root, ranges, req(3))]), '2');
    });

    it('falls back to the nearest block when the requested block exists but holds none of the matches', () => {
      const root = page(`${DOC}<p data-line="6">bar</p>`);
      const ranges = matches(root, 'foo');
      assert.equal(mod.pickCurrent(root, ranges, req(6)), 3); // line 4 is two away, line 2 four
    });

    it('treats text outside any data-line element as line 0 when measuring the distance', () => {
      const root = page('<div>foo</div><p data-line="9">foo</p>');
      const ranges = matches(root, 'foo');
      assert.equal(mod.pickCurrent(root, ranges, req(3)), 0); // 0 -> distance 3, 9 -> distance 6
      assert.equal(mod.pickCurrent(root, ranges, req(8)), 1);
    });

    describe('nested blocks', () => {
      const NESTED = '<ul data-line="0"><li data-line="0">foo</li><li data-line="1">foo</li></ul><blockquote data-line="3"><p data-line="3">foo</p><p data-line="5">foo</p></blockquote>';

      it('with the same line on a list and its first item, the outer element wins and occurrences count over the whole list', () => {
        const root = page(NESTED);
        const ranges = matches(root, 'foo');
        assert.equal(ranges.length, 4);
        assert.equal(mod.pickCurrent(root, ranges, req(0, 0)), 0);
        assert.equal(mod.pickCurrent(root, ranges, req(0, 1)), 1);
        assert.equal(mod.pickCurrent(root, ranges, req(0, 2)), 1); // the list has two matches; the quote is outside it
      });

      it('picks inside a nested block when the requested line starts only that one', () => {
        const root = page(NESTED);
        const ranges = matches(root, 'foo');
        assert.equal(mod.pickCurrent(root, ranges, req(1, 0)), 1); // second list item
        assert.equal(mod.pickCurrent(root, ranges, req(5, 0)), 3); // second paragraph of the quote
      });

      it('with a block that wraps both a parent and a child on one line, the outer one counts every match inside', () => {
        const root = page(NESTED);
        const ranges = matches(root, 'foo');
        assert.equal(mod.pickCurrent(root, ranges, req(3, 0)), 2);
        assert.equal(mod.pickCurrent(root, ranges, req(3, 1)), 3);
      });

      it('measures the fallback distance from the innermost data-line element around a match', () => {
        // Match 0 sits in a paragraph at line 6 inside an item that starts at line 0; match 1 is at line 10.
        // From line 7 the innermost line (6) is nearest; had the item's line (0) been used, match 1 would win.
        const root = page('<ul data-line="0"><li data-line="0"><p data-line="6">foo</p></li></ul><p data-line="10">foo</p>');
        const ranges = matches(root, 'foo');
        assert.equal(mod.pickCurrent(root, ranges, req(7)), 0);
      });
    });

    it('ignores matches the index skips: removed blocks, diagrams and removed words are never targets', () => {
      const root = page(
        '<div class="rm-chg-del"><p data-line="3">foo removed</p></div>' +
          '<div class="rm-chg-move-from"><p>foo moved from</p></div>' +
          '<div class="rm-mermaid"><pre data-line="3">foo in a diagram</pre></div>' +
          '<p data-line="5">a <del class="rm-del">foo</del> b foo</p>',
      );
      const ranges = matches(root, 'foo');
      assert.equal(ranges.length, 1);
      // Line 3 exists in the DOM (inside skipped content) but holds no match: the nearest live block is chosen.
      assert.equal(mod.pickCurrent(root, ranges, req(3)), 0);
      assert.equal(lineOfRange(ranges[0]), '5');
      assert.equal(ranges[0].toString(), 'foo');
    });

    it('returns 0 when there are no matches', () => {
      const root = page(DOC);
      assert.equal(mod.pickCurrent(root, [], req(2)), 0);
      assert.equal(mod.pickCurrent(page('<p>nothing</p>'), [], req(0, 3)), 0);
    });
  });

  describe('highlighting (CSS.highlights stubbed)', () => {
    const DOC = '<h1 data-line="0">foo</h1><p data-line="2">foo and Foo</p><div class="rm-chg-del"><p>foo</p></div><p data-line="4">foo</p>';
    let badge: HTMLElement;
    let root: HTMLElement;

    beforeEach(() => {
      badge = document.createElement('span');
      badge.hidden = true;
      mod.initSearch(badge);
      root = page(DOC);
    });

    afterEach(() => {
      mod.setSearch(root, { term: '', caseSensitive: false, blockLine: 0, occurrence: 0 });
    });

    const registered = (name: string): Range[] => registry.get(name)?.ranges ?? [];

    it('registers every match, the current one separately, and shows the count', () => {
      mod.setSearch(root, req(2, 1));
      const all = registered('rm-search');
      const current = registered('rm-search-current');
      // Four live matches (the removed block is skipped): current is the second one in the paragraph at line 2.
      assert.equal(all.length + current.length, 4);
      assert.equal(current.length, 1);
      assert.equal(lineOfRange(current[0]), '2');
      assert.equal(current[0].toString(), 'Foo');
      assert.deepEqual(
        all.map((r) => [lineOfRange(r), r.toString()]),
        [
          ['0', 'foo'],
          ['2', 'foo'],
          ['4', 'foo'],
        ],
      );
      assert.equal(badge.hidden, false);
      assert.equal(badge.textContent, '“foo” 3/4');
      assert.equal(badge.classList.contains('rm-no-match'), false);
    });

    it('respects case sensitivity', () => {
      mod.setSearch(root, { term: 'foo', caseSensitive: true, blockLine: 2, occurrence: 1 });
      // `Foo` no longer matches: the occurrence index is clamped to the one match left in the block.
      assert.equal(registered('rm-search').length + registered('rm-search-current').length, 3);
      assert.equal(registered('rm-search-current')[0].toString(), 'foo');
      assert.equal(badge.textContent, '“foo” 2/3');
    });

    it('registers an empty highlight for the others when there is one match', () => {
      mod.setSearch(root, { term: 'and', caseSensitive: false, blockLine: 2, occurrence: 0 });
      assert.deepEqual(registered('rm-search'), []);
      assert.equal(registered('rm-search-current').length, 1);
      assert.ok(registry.has('rm-search'));
      assert.equal(badge.textContent, '“and” 1/1');
    });

    it('reports no matches and registers nothing', () => {
      mod.setSearch(root, req(2, 0, 'absent'));
      assert.equal(registry.size, 0);
      assert.equal(badge.hidden, false);
      assert.equal(badge.textContent, '“absent” no matches');
      assert.equal(badge.classList.contains('rm-no-match'), true);
    });

    it('truncates a long term in the badge', () => {
      mod.setSearch(root, req(2, 0, 'x'.repeat(40)));
      assert.equal(badge.textContent, `“${'x'.repeat(30)}…” no matches`);
    });

    it('clears the highlights and hides the badge when the term is emptied', () => {
      mod.setSearch(root, req(2, 0));
      assert.ok(registry.has('rm-search') && registry.has('rm-search-current'));
      mod.setSearch(root, { term: '', caseSensitive: false, blockLine: 0, occurrence: 0 });
      assert.equal(registry.size, 0);
      assert.equal(badge.hidden, true);
    });

    it('replaces the earlier highlights instead of adding to them', () => {
      mod.setSearch(root, req(2, 0));
      mod.setSearch(root, req(2, 0, 'and'));
      assert.equal(registered('rm-search-current')[0].toString(), 'and');
      assert.deepEqual(registered('rm-search'), []);
    });

    it('re-applies after a re-render without moving the page, on the new content', () => {
      mod.setSearch(root, req(4, 0));
      layout.scrolls.length = 0;
      root.innerHTML = '<p data-line="0">foo</p><p data-line="4">foo foo</p>';
      rangeRect = { top: 5000, bottom: 5020 }; // off screen: only a reveal would scroll
      mod.reapplySearch(root);
      assert.equal(registered('rm-search').length + registered('rm-search-current').length, 3);
      assert.equal(lineOfRange(registered('rm-search-current')[0]), '4');
      assert.equal(badge.textContent, '“foo” 2/3');
      assert.equal(layout.scrolls.length, 0);
    });

    it('scrolls the current match into the upper third when it is off screen, and leaves a visible one alone', () => {
      rangeRect = { top: 2000, bottom: 2020 };
      mod.setSearch(root, req(4, 0));
      assert.deepEqual(layout.scrolls, [{ top: 2000 - 800 / 3, behavior: 'instant' }]);

      layout.scrolls.length = 0;
      layout.scrollY = 0;
      rangeRect = { top: 100, bottom: 120 };
      mod.setSearch(root, req(4, 0));
      assert.equal(layout.scrolls.length, 0);

      rangeRect = { top: -50, bottom: -30 };
      layout.scrollY = 600;
      mod.setSearch(root, req(4, 0));
      assert.deepEqual(layout.scrolls, [{ top: 600 - 50 - 800 / 3, behavior: 'instant' }]);
    });
  });
});
