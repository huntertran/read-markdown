import * as assert from 'node:assert/strict';
import type { Heading } from '../../src/protocol';
import { useDom } from './dom';

// nav.ts pulls in scroll.ts, which registers window listeners at import time, so both are loaded
// after useDom() has installed the window instead of at the top of the file.
type Nav = typeof import('../../webview/nav');
type Scroll = typeof import('../../webview/scroll');

interface Layout {
  /** Absolute top per slug, or undefined for a hidden heading (no client rects). */
  tops: Record<string, number | undefined>;
  scrollY: number;
}

describe('nav active heading', () => {
  useDom();

  let nav: Nav;
  let scroll: Scroll;
  const layout: Layout = { tops: {}, scrollY: 0 };
  let content: HTMLElement;
  let list: HTMLOListElement;
  let slugs: string[];
  let proto: Element;
  let savedScrollIntoView: PropertyDescriptor | undefined;

  before(async () => {
    nav = await import('../../webview/nav');
    scroll = await import('../../webview/scroll');
    // jsdom has no layout: scrollY and scrollIntoView are missing or fixed at 0.
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => layout.scrollY });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    // Kept in a variable: useDom's own `after` hook runs first and removes the Element global.
    proto = Element.prototype;
    savedScrollIntoView = Object.getOwnPropertyDescriptor(proto, 'scrollIntoView');
    Object.defineProperty(proto, 'scrollIntoView', { configurable: true, value: () => {} });
  });

  after(() => {
    if (savedScrollIntoView) Object.defineProperty(proto, 'scrollIntoView', savedScrollIntoView);
    else delete (proto as unknown as Record<string, unknown>).scrollIntoView;
  });

  /** Builds the page with stubbed geometry and initializes nav on it. */
  function setup(tops: Record<string, number | undefined>): void {
    layout.tops = tops;
    layout.scrollY = 0;
    slugs = Object.keys(tops);
    content = document.createElement('div');
    list = document.createElement('ol');
    const empty = document.createElement('div');
    const filter = document.createElement('input');
    document.body.append(content, list, empty, filter);
    for (const slug of slugs) {
      const h = document.createElement('h2');
      h.id = slug;
      h.getClientRects = () => (layout.tops[slug] === undefined ? [] : [{}]) as unknown as DOMRectList;
      h.getBoundingClientRect = () => ({ top: (layout.tops[slug] ?? 0) - layout.scrollY }) as DOMRect;
      content.append(h);
    }
    nav.initNav({ list, empty, filter, content, onNavigate: () => {} });
    const headings: Heading[] = slugs.map((slug, i) => ({ level: 2, text: slug, slug, line: i }));
    nav.setHeadings(headings, 6);
  }

  /** The loop `updateActive` ran before the cache, on the live geometry. */
  function reference(): string {
    const threshold = Math.min(120, window.innerHeight / 4);
    let slug = slugs[0] ?? '';
    for (const s of slugs) {
      const el = document.getElementById(s);
      if (!el || !content.contains(el) || el.getClientRects().length === 0) continue;
      if (el.getBoundingClientRect().top <= threshold) slug = s;
      else break;
    }
    return slug;
  }

  const activeSlug = (): string | undefined => list.querySelector<HTMLElement>('.rm-active')?.dataset.slug;

  function scrollTo(y: number): void {
    layout.scrollY = y;
    nav.updateActive();
  }

  it('matches the live-geometry scan at every scroll position', () => {
    setup({ a: 0, b: 400, c: 900, d: 1500, e: 2600 });
    for (const y of [0, 50, 281, 282, 500, 780, 900, 1380, 1400, 2500, 2480, 9999, 100, 0]) {
      scrollTo(y);
      assert.equal(activeSlug(), reference(), `scrollY ${y}`);
    }
  });

  it('highlights the first heading while scrolled above it', () => {
    setup({ a: 600, b: 1000 });
    scrollTo(0);
    assert.equal(activeSlug(), 'a');
    assert.equal(reference(), 'a');
  });

  it('skips hidden headings (collapsed sections) once the cache is invalidated', () => {
    setup({ a: 0, b: 400, c: 800, d: 1200 });
    scrollTo(1100);
    assert.equal(activeSlug(), 'd');
    // b and c get collapsed away, everything below moves up; fold clicks call invalidate().
    layout.tops = { a: 0, b: undefined, c: undefined, d: 500 };
    scroll.invalidate();
    scrollTo(450);
    assert.equal(activeSlug(), reference());
    assert.equal(activeSlug(), 'd');
    scrollTo(300);
    assert.equal(activeSlug(), reference());
    assert.equal(activeSlug(), 'a');
  });

  it('measures heading positions once per invalidation, not once per scroll frame', () => {
    setup({ a: 0, b: 400, c: 900 });
    let reads = 0;
    for (const slug of slugs) {
      const el = document.getElementById(slug) as HTMLElement;
      const top = (): number => (layout.tops[slug] ?? 0) - layout.scrollY;
      el.getBoundingClientRect = () => (reads++, { top: top() } as DOMRect);
    }
    scroll.invalidate();
    for (const y of [0, 100, 500, 700, 1000]) scrollTo(y);
    assert.equal(reads, 3, 'one rect read per heading for the whole run');
    scroll.invalidate();
    scrollTo(1100);
    assert.equal(reads, 6);
  });

  it('re-measures when the headings of a new render are set', () => {
    setup({ a: 0, b: 400 });
    scrollTo(500);
    assert.equal(activeSlug(), 'b');
    layout.tops = { a: 0, b: 1400 };
    nav.setHeadings(slugs.map((slug, i) => ({ level: 2, text: slug, slug, line: i })), 6);
    assert.equal(activeSlug(), 'a');
  });

  it('does nothing without headings', () => {
    setup({});
    assert.doesNotThrow(() => scrollTo(300));
    assert.equal(activeSlug(), undefined);
  });
});
