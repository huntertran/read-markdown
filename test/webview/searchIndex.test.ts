import * as assert from 'node:assert/strict';
import { buildTextIndex, createIndexCache, findMatches, skipClassesChanged, type TextIndex } from '../../webview/searchIndex';
import { useDom } from './dom';

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

/** Matches as text plus the block they start in, which is what search reports and highlights. */
function matchTexts(index: TextIndex, term: string, caseSensitive = false): string[] {
  return findMatches(index, term, caseSensitive).map((r) => r.toString());
}

const DOC = `
  <h1 id="a">Alpha beta</h1>
  <p>one <em>beta</em> two beta</p>
  <pre class="rm-mermaid">beta in a diagram</pre>
  <p>three <del class="rm-del">beta</del> four</p>
  <ul><li>beta item</li><li>other</li></ul>`;

describe('search index', () => {
  useDom();

  describe('buildTextIndex / findMatches', () => {
    it('skips mermaid blocks, removed text and fold buttons', () => {
      const r = root(DOC + '<div class="rm-chg-del"><p>beta removed</p></div><h2><button class="rm-fold">beta</button>beta</h2>');
      // Live occurrences: h1, em, p text, li and h2 (diagram, del, removed block and button text are skipped).
      assert.equal(findMatches(buildTextIndex(r), 'beta', false).length, 5);
    });

    it('keeps matches inside one block and ignores case unless asked', () => {
      const r = root('<p>Foo</p><p>bar foo</p>');
      const index = buildTextIndex(r);
      assert.deepEqual(matchTexts(index, 'foo'), ['Foo', 'foo']);
      assert.deepEqual(matchTexts(index, 'foo', true), ['foo']);
      assert.deepEqual(matchTexts(index, 'Foo bar'), []); // never across blocks
    });

    it('matches a term over inline markup and flexible whitespace', () => {
      const r = root('<p>say <strong>hello</strong>  world</p>');
      assert.deepEqual(matchTexts(buildTextIndex(r), 'hello world'), ['hello  world']);
    });

    it('is stable across repeated lookups (a highlight/clear cycle does not touch the DOM)', () => {
      const r = root(DOC);
      const cache = createIndexCache(r);
      const first = matchTexts(cache.get(), 'beta');
      const html = r.innerHTML;
      // Highlights use the CSS Custom Highlight API: ranges are created and dropped, the DOM is untouched.
      const ranges = findMatches(cache.get(), 'beta', false);
      ranges.length = 0;
      assert.equal(r.innerHTML, html);
      assert.deepEqual(matchTexts(cache.get(), 'beta'), first);
      assert.deepEqual(matchTexts(buildTextIndex(r), 'beta'), first);
      cache.dispose();
    });
  });

  describe('skipClassesChanged', () => {
    it('reports only changes to classes that SKIP depends on', () => {
      const el = document.createElement('p');
      el.className = 'rm-active hovered';
      assert.equal(skipClassesChanged('rm-active', el), false);
      assert.equal(skipClassesChanged(null, el), false);
      el.className = 'rm-chg-del';
      assert.equal(skipClassesChanged('', el), true);
      el.className = '';
      assert.equal(skipClassesChanged('rm-mermaid x', el), true);
      el.className = 'x rm-fold';
      assert.equal(skipClassesChanged('rm-fold', el), false);
    });
  });

  describe('index cache', () => {
    /** The cache must give exactly what a fresh walk gives, after `change`, before the observer callback runs. */
    function assertFresh(html: string, change: (r: HTMLElement) => void, term = 'beta'): void {
      const r = root(html);
      const cache = createIndexCache(r);
      cache.get(); // warm
      change(r);
      assert.deepEqual(matchTexts(cache.get(), term), matchTexts(buildTextIndex(r), term));
      assert.equal(cache.get().text, buildTextIndex(r).text);
      cache.dispose();
    }

    it('reuses the index while nothing changed', () => {
      const r = root(DOC);
      const cache = createIndexCache(r);
      assert.equal(cache.get(), cache.get());
      cache.dispose();
    });

    it('stays valid across irrelevant mutations (hover class, attributes, collapse)', () => {
      const r = root(DOC);
      const cache = createIndexCache(r);
      const index = cache.get();
      r.querySelector('p')?.classList.add('hover', 'rm-collapsed');
      r.querySelector('li')?.setAttribute('data-x', '1');
      assert.equal(cache.get(), index);
      cache.dispose();
    });

    it('rebuilds after a simulated re-render (replaceChildren)', () => {
      assertFresh(DOC, (r) => {
        const next = document.createElement('div');
        next.innerHTML = '<p>fresh beta</p><p>beta again beta</p>';
        r.replaceChildren(...next.childNodes);
      });
    });

    it('rebuilds after text is edited in place', () => {
      assertFresh(DOC, (r) => {
        const text = r.querySelector('li')?.firstChild as Text;
        text.data = 'nothing here';
      });
    });

    it('rebuilds after a word diff wraps text in ins/del (changes.ts)', () => {
      assertFresh(DOC, (r) => {
        const p = r.querySelectorAll('p')[0];
        p.innerHTML = 'one <ins class="rm-ins">beta</ins> <del class="rm-del">beta beta</del> two';
      });
    });

    it('rebuilds after an element gains or loses a SKIP class', () => {
      assertFresh(DOC, (r) => r.querySelector('li')?.classList.add('rm-chg-del'));
      assertFresh(DOC, (r) => r.querySelector('pre')?.classList.remove('rm-mermaid'));
    });

    it('rebuilds after a block is swapped for an editor and back', () => {
      assertFresh(DOC, (r) => {
        const p = r.querySelector('p') as HTMLElement;
        const editor = document.createElement('div');
        editor.className = 'rm-editor';
        const area = document.createElement('textarea');
        editor.append(area);
        p.replaceWith(editor);
      });
      assertFresh(DOC, (r) => {
        const p = r.querySelector('p') as HTMLElement;
        const editor = document.createElement('div');
        p.replaceWith(editor);
        editor.replaceWith(p);
      });
    });

    it('rebuilds after a diagram render replaces its content', () => {
      assertFresh(DOC, (r) => {
        const pre = r.querySelector('pre') as HTMLElement;
        pre.innerHTML = '<svg><text>beta</text></svg>';
        pre.classList.remove('rm-mermaid'); // placeholder turned into a plain block
      });
    });

    it('rebuilds after list items are reordered', () => {
      assertFresh(DOC, (r) => {
        const ul = r.querySelector('ul') as HTMLElement;
        ul.append(ul.firstElementChild as Element);
      });
    });

    it('also invalidates through the observer callback (async path) and explicit invalidate()', async () => {
      const r = root(DOC);
      const cache = createIndexCache(r);
      const before = cache.get();
      (r.querySelector('li')?.firstChild as Text).data = 'beta beta';
      await new Promise((resolve) => setTimeout(resolve, 0)); // records delivered to the callback, not takeRecords
      const after = cache.get();
      assert.notEqual(after, before);
      assert.deepEqual(matchTexts(after, 'beta'), matchTexts(buildTextIndex(r), 'beta'));
      cache.invalidate();
      assert.notEqual(cache.get(), after);
      cache.dispose();
    });

    it('stops observing after dispose', () => {
      const r = root(DOC);
      const cache = createIndexCache(r);
      cache.get();
      cache.dispose();
      r.append(document.createElement('p'));
      assert.doesNotThrow(() => cache.get()); // rebuilds from scratch, nothing left over
    });
  });
});
