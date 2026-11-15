import * as assert from 'node:assert/strict';
import { buildSections, expandTo, onSectionsChange, setAllCollapsed, setCollapsed, type SectionOptions } from '../../webview/sections';
import { useDom } from './dom';

const OPTS: SectionOptions = { collapsible: true, startCollapsedBelowLevel: 0, collapsed: undefined };
const HTML = '<h1 id="a">A</h1><p>x</p><h2 id="b">B</h2><p>y</p><h3 id="c">C</h3><p>deep</p>';

describe('sections change notification', () => {
  useDom();

  // The listener list is module-wide and only grows, so the tests share one counter.
  let calls = 0;
  before(() => onSectionsChange(() => calls++));
  beforeEach(() => (calls = 0));

  function build(opts: Partial<SectionOptions> = {}): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = HTML;
    buildSections(root, { ...OPTS, ...opts });
    return root;
  }

  it('fires once per build, also for a start-collapsed build and a non-collapsible one', () => {
    build();
    assert.equal(calls, 1);
    build({ startCollapsedBelowLevel: 1 });
    assert.equal(calls, 2);
    build({ collapsible: false });
    assert.equal(calls, 3); // the previous render's sections are gone, the fold-all button must hide
  });

  it('fires for a fold click (setCollapsed)', () => {
    const root = build();
    calls = 0;
    setCollapsed(root.querySelector('section') as Element, true);
    assert.equal(calls, 1);
  });

  it('fires once for fold all, however many sections there are', () => {
    const root = build();
    calls = 0;
    setAllCollapsed(root, true);
    assert.equal(calls, 1);
    assert.equal(root.querySelectorAll('.rm-collapsed').length, 3);
  });

  it('fires once from expandTo only when it expanded something', () => {
    const root = build({ startCollapsedBelowLevel: 1 });
    calls = 0;
    assert.equal(expandTo(root.querySelector('#c ~ *') ?? root.querySelector('#c')), true);
    assert.equal(calls, 1, 'one notification for the whole chain of sections');
    assert.equal(expandTo(root.querySelector('p')), false);
    assert.equal(calls, 1, 'no change, no notification');
  });
});
