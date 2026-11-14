import * as assert from 'node:assert/strict';
import { buildSections, collapsedSlugs, expandTo, setAllCollapsed, setCollapsed, type SectionOptions } from '../../webview/sections';
import { useDom } from './dom';

const OPTS: SectionOptions = { collapsible: true, startCollapsedBelowLevel: 0, collapsed: undefined };

/** A root element holding `html`, run through `buildSections`. */
function build(html: string, opts: Partial<SectionOptions> = {}): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  buildSections(root, { ...OPTS, ...opts });
  return root;
}

/** Nesting outline such as `h1(a) > [h2(b), h2(c)]`, by slug, to compare tree shapes. */
function outline(parent: Element): unknown[] {
  return [...parent.querySelectorAll(':scope > section.rm-section')].map((s) => {
    const kids = outline(s.querySelector(':scope > .rm-section-body') as Element);
    return kids.length ? { [(s as HTMLElement).dataset.slug as string]: kids } : (s as HTMLElement).dataset.slug;
  });
}

describe('sections', () => {
  useDom();

  describe('buildSections', () => {
    it('does nothing when sections are not collapsible', () => {
      const root = build('<h1 id="a">A</h1><p>x</p>', { collapsible: false });
      assert.equal(root.querySelectorAll('section').length, 0);
      assert.equal(root.children.length, 2);
    });

    it('wraps a heading and its content in a section with level and slug', () => {
      const root = build('<h2 id="intro">Intro</h2><p>one</p><p>two</p>');
      const section = root.querySelector('section.rm-section') as HTMLElement;
      assert.ok(section);
      assert.equal(section.dataset.level, '2');
      assert.equal(section.dataset.slug, 'intro');
      const body = section.querySelector(':scope > .rm-section-body') as HTMLElement;
      assert.deepEqual(
        [...body.children].map((c) => c.tagName),
        ['P', 'P'],
      );
      assert.equal(root.children.length, 1);
    });

    it('keeps the heading as the first child of its section and gives it a fold button', () => {
      const root = build('<h1 id="a">A</h1><p>x</p>');
      const heading = root.querySelector('section > h1') as HTMLElement;
      assert.ok(heading.classList.contains('rm-heading'));
      assert.equal(heading.id, 'a');
      const fold = heading.querySelector(':scope > button.rm-fold') as HTMLButtonElement;
      assert.ok(fold);
      assert.equal(fold.type, 'button');
      assert.equal(fold.getAttribute('aria-expanded'), 'true');
      assert.equal(heading.firstElementChild, fold);
      assert.equal(heading.textContent, 'A');
    });

    it('nests deeper headings and closes sections at the same or a higher level', () => {
      const root = build('<h1 id="a">A</h1><h2 id="b">B</h2><h3 id="c">C</h3><h2 id="d">D</h2><h1 id="e">E</h1>');
      assert.deepEqual(outline(root), [{ a: [{ b: ['c'] }, 'd'] }, 'e']);
    });

    it('puts content into the innermost open section', () => {
      const root = build('<h1 id="a">A</h1><p id="p1">1</p><h2 id="b">B</h2><p id="p2">2</p><h1 id="c">C</h1><p id="p3">3</p>');
      const parentSlug = (id: string) => (root.querySelector(`#${id}`)?.closest('section') as HTMLElement).dataset.slug;
      assert.equal(parentSlug('p1'), 'a');
      assert.equal(parentSlug('p2'), 'b');
      assert.equal(parentSlug('p3'), 'c');
      // b's section is nested in a's body.
      const sectionB = root.querySelector('#p2')?.closest('section') as HTMLElement;
      assert.equal(sectionB.parentElement?.closest('section')?.dataset.slug, 'a');
    });

    it('leaves content before the first heading at the top level', () => {
      const root = build('<p id="lead">intro</p><hr><h1 id="a">A</h1><p>x</p>');
      assert.deepEqual(
        [...root.children].map((c) => c.tagName),
        ['P', 'HR', 'SECTION'],
      );
      assert.equal(root.querySelector(':scope > #lead')?.textContent, 'intro');
    });

    it('handles a document without headings', () => {
      const root = build('<p>a</p><p>b</p>');
      assert.equal(root.querySelectorAll('section').length, 0);
      assert.equal(root.children.length, 2);
    });

    it('handles level jumps: h1 -> h3 -> h2', () => {
      const root = build('<h1 id="a">A</h1><h3 id="c">C</h3><h2 id="b">B</h2>');
      // h3 nests directly under h1; the following h2 is a sibling of h3 under h1 (not under h3).
      assert.deepEqual(outline(root), [{ a: ['c', 'b'] }]);
      assert.equal((root.querySelector('[data-slug="c"]') as HTMLElement).dataset.level, '3');
    });

    it('handles a document starting at h3 followed by h1', () => {
      const root = build('<h3 id="c">C</h3><p>x</p><h1 id="a">A</h1><h2 id="b">B</h2>');
      assert.deepEqual(outline(root), ['c', { a: ['b'] }]);
    });

    it('wraps top-level blocks of every kind, not just paragraphs', () => {
      const root = build('<h1 id="a">A</h1><ul><li>x</li></ul><pre><code>c</code></pre><table><tbody><tr><td>1</td></tr></tbody></table>');
      const body = root.querySelector('.rm-section-body') as HTMLElement;
      assert.deepEqual(
        [...body.children].map((c) => c.tagName),
        ['UL', 'PRE', 'TABLE'],
      );
    });

    it('preserves nested element identity and order', () => {
      const root = document.createElement('div');
      root.innerHTML = '<h1 id="a">A</h1><p id="x">x</p>';
      const p = root.querySelector('#x');
      buildSections(root, OPTS);
      assert.equal(root.querySelector('#x'), p);
    });
  });

  describe('initial collapsed state', () => {
    const doc = '<h1 id="a">A</h1><h2 id="b">B</h2><h3 id="c">C</h3><h2 id="d">D</h2>';
    const collapsedOf = (root: HTMLElement) => collapsedSlugs(root).sort();

    it('starts expanded by default', () => {
      assert.deepEqual(collapsedOf(build(doc)), []);
    });

    it('collapses sections at or below startCollapsedBelowLevel on the first render', () => {
      assert.deepEqual(collapsedOf(build(doc, { startCollapsedBelowLevel: 2 })), ['b', 'c', 'd']);
      assert.deepEqual(collapsedOf(build(doc, { startCollapsedBelowLevel: 3 })), ['c']);
    });

    it('updates aria-expanded on the fold button of collapsed sections', () => {
      const root = build(doc, { startCollapsedBelowLevel: 3 });
      const fold = (slug: string) => root.querySelector(`section[data-slug="${slug}"] > .rm-heading > .rm-fold`);
      assert.equal(fold('c')?.getAttribute('aria-expanded'), 'false');
      assert.equal(fold('b')?.getAttribute('aria-expanded'), 'true');
    });

    it('applies saved slugs instead of the level rule on later renders', () => {
      const root = build(doc, { startCollapsedBelowLevel: 2, collapsed: new Set(['a']) });
      assert.deepEqual(collapsedOf(root), ['a']);
    });

    it('expands everything when the saved set is empty', () => {
      assert.deepEqual(collapsedOf(build(doc, { startCollapsedBelowLevel: 1, collapsed: new Set() })), []);
    });

    it('ignores saved slugs that no longer exist', () => {
      assert.deepEqual(collapsedOf(build(doc, { collapsed: new Set(['gone', 'b']) })), ['b']);
    });
  });

  describe('removed blocks (track changes)', () => {
    it('does not start a section for a removed heading', () => {
      const root = build('<h1 id="a">A</h1><h2 class="rm-chg-del">Old</h2><p>x</p><h2 id="b">B</h2>');
      assert.deepEqual(outline(root), [{ a: ['b'] }]);
      const removed = root.querySelector('.rm-chg-del') as HTMLElement;
      assert.equal(removed.tagName, 'H2');
      assert.equal(removed.querySelector('.rm-fold'), null);
      assert.ok(!removed.classList.contains('rm-heading'));
      // Shown in place: it stays in the body of the open section.
      assert.equal(removed.closest('section')?.dataset.slug, 'a');
    });

    it('treats a moved-from heading clone like a removed one', () => {
      const root = build('<h1 id="a">A</h1><h1 class="rm-chg-move-from">Moved</h1><p>x</p>');
      assert.equal(root.querySelectorAll('section').length, 1);
      assert.equal(root.querySelector('.rm-chg-move-from')?.closest('section')?.dataset.slug, 'a');
    });

    it('keeps a heading that is added or modified as a normal section', () => {
      const root = build('<h1 id="a" class="rm-chg-ins">A</h1><h1 id="b" class="rm-chg-mod">B</h1>');
      assert.deepEqual(outline(root), ['a', 'b']);
    });

    it('lets removed headings before the first heading stay at the top level', () => {
      const root = build('<h1 class="rm-chg-del">Old</h1><h1 id="a">A</h1>');
      assert.equal(root.firstElementChild?.tagName, 'H1');
      assert.ok(root.firstElementChild?.classList.contains('rm-chg-del'));
      assert.equal(root.querySelectorAll('section').length, 1);
    });
  });

  describe('collapse helpers', () => {
    it('setCollapsed toggles the class and aria-expanded', () => {
      const root = build('<h1 id="a">A</h1><p>x</p>');
      const section = root.querySelector('section') as HTMLElement;
      setCollapsed(section, true);
      assert.ok(section.classList.contains('rm-collapsed'));
      assert.equal(section.querySelector('.rm-fold')?.getAttribute('aria-expanded'), 'false');
      setCollapsed(section, false);
      assert.ok(!section.classList.contains('rm-collapsed'));
      assert.equal(section.querySelector('.rm-fold')?.getAttribute('aria-expanded'), 'true');
    });

    it('setAllCollapsed and collapsedSlugs cover every section', () => {
      const root = build('<h1 id="a">A</h1><h2 id="b">B</h2><h1 id="c">C</h1>');
      setAllCollapsed(root, true);
      assert.deepEqual(collapsedSlugs(root).sort(), ['a', 'b', 'c']);
      setAllCollapsed(root, false);
      assert.deepEqual(collapsedSlugs(root), []);
    });

    it('collapsedSlugs skips sections without a slug', () => {
      const root = build('<h1>No id</h1><p>x</p>');
      setAllCollapsed(root, true);
      assert.deepEqual(collapsedSlugs(root), []);
    });

    it('expandTo expands collapsed ancestors of a node', () => {
      const root = build('<h1 id="a">A</h1><h2 id="b">B</h2><p id="deep">x</p>');
      setAllCollapsed(root, true);
      assert.equal(expandTo(root.querySelector('#deep')), true);
      assert.deepEqual(collapsedSlugs(root), []);
    });

    it('expandTo leaves a section collapsed when the target is its own heading', () => {
      const root = build('<h1 id="a">A</h1><h2 id="b">B</h2><p>x</p>');
      setAllCollapsed(root, true);
      // The h2 is visible once its parent section is open; its own section may stay collapsed.
      expandTo(root.querySelector('#b'));
      assert.deepEqual(collapsedSlugs(root), ['b']);
    });

    it('expandTo reports false when nothing is collapsed', () => {
      const root = build('<h1 id="a">A</h1><p id="x">x</p>');
      assert.equal(expandTo(root.querySelector('#x')), false);
      assert.equal(expandTo(null), false);
    });
  });
});
