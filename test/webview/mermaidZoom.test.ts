import * as assert from 'node:assert/strict';
import { useDom } from './dom';

// mermaidZoom.ts is loaded after the DOM exists (changes.ts -> sanitize.ts reach for `window`).
//
// Covered: where the Ctrl/Cmd+wheel zoom listener lives and what it does. Not covered here (manual):
// the zoom geometry against real layout (jsdom rects are all zero), panning, the full-screen view.
type MermaidZoom = typeof import('../../webview/mermaidZoom');

interface Registration {
  target: EventTarget;
  type: string;
  passive: boolean | undefined;
}

describe('diagram zoom wheel listener', () => {
  useDom({ globals: ['WheelEvent', 'EventTarget'] });

  let mod: MermaidZoom;
  let root: HTMLElement;
  const registrations: Registration[] = [];
  let restoreAdd: (() => void) | undefined;

  /**
   * Views are kept per diagram source across renders, and a diagram whose source changed inherits the
   * view at its position, so every test draws sources of its own and ends with an empty render.
   */
  let fresh = 0;
  /** One rendered diagram (as renderMermaid leaves it) and a paragraph, `count` times. */
  function content(count = 1): string {
    return Array.from({ length: count }, () => {
      const n = fresh++;
      return `<div class="rm-mermaid"><pre class="mermaid" data-src="graph TD; A${n}-->B"><svg id="m${n}"></svg></pre></div><p>text ${n}</p>`;
    }).join('');
  }

  const diagrams = () => [...root.querySelectorAll<HTMLElement>('.rm-mermaid > pre.mermaid')];
  const svgOf = (pre: HTMLElement) => pre.querySelector<SVGSVGElement>(':scope > svg')!;

  function wheel(target: Element, init: { ctrlKey?: boolean; metaKey?: boolean } = {}): WheelEvent {
    const e = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, ...init });
    target.dispatchEvent(e);
    return e;
  }

  before(async () => {
    // Records every listener registration, to check where the non-passive wheel listener goes.
    const proto = window.EventTarget.prototype;
    const add: EventTarget['addEventListener'] = Reflect.get(proto, 'addEventListener');
    proto.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      registrations.push({ target: this, type, passive: typeof options === 'object' ? options.passive : undefined });
      add.call(this, type, listener, options);
    };
    restoreAdd = () => {
      proto.addEventListener = add;
    };
    mod = await import('../../webview/mermaidZoom');
  });

  after(() => restoreAdd?.());

  beforeEach(() => {
    root = document.createElement('article');
    root.id = 'rm-content';
    document.body.append(root);
    registrations.length = 0;
    mod.initDiagramZoom(root);
    root.innerHTML = content(2);
    mod.decorateDiagrams(root);
  });

  afterEach(() => {
    root.replaceChildren();
    mod.decorateDiagrams(root);
  });

  it('puts no wheel listener on the content, only on each diagram', () => {
    assert.deepEqual(
      registrations.filter((r) => r.target === root && r.type === 'wheel'),
      [],
      'a non-passive wheel listener on the content makes the whole document a blocking scroll region',
    );
    for (const pre of diagrams()) {
      const wheels = registrations.filter((r) => r.target === pre && r.type === 'wheel');
      assert.equal(wheels.length, 1);
      assert.equal(wheels[0].passive, false, 'it calls preventDefault, so it must not be passive');
    }
  });

  it('adds the listener once per diagram, however often diagrams are decorated', () => {
    mod.decorateDiagrams(root);
    mod.decorateDiagrams(root);
    for (const pre of diagrams()) assert.equal(registrations.filter((r) => r.target === pre && r.type === 'wheel').length, 1);
  });

  it('Ctrl+wheel and Cmd+wheel over a diagram zoom it and stop the page from scrolling', () => {
    const [first, second] = diagrams();
    const e = wheel(svgOf(first), { ctrlKey: true });
    assert.equal(e.defaultPrevented, true);
    assert.match(svgOf(first).style.transform, /scale\(/);
    assert.ok(first.classList.contains('rm-zoomed'));
    assert.equal(svgOf(second).style.transform, '', 'the other diagram keeps its view');

    const m = wheel(second, { metaKey: true });
    assert.equal(m.defaultPrevented, true);
    assert.match(svgOf(second).style.transform, /scale\(/);
  });

  it('a plain wheel over a diagram scrolls the page', () => {
    const [first] = diagrams();
    const e = wheel(svgOf(first));
    assert.equal(e.defaultPrevented, false);
    assert.equal(svgOf(first).style.transform, '');
  });

  it('Ctrl+wheel outside a diagram is left to the browser', () => {
    const e = wheel(root.querySelector('p')!, { ctrlKey: true });
    assert.equal(e.defaultPrevented, false);
  });

  it('diagrams of a new render get the listener too', () => {
    root.innerHTML = content(3);
    mod.decorateDiagrams(root);
    const pres = diagrams();
    assert.equal(pres.length, 3);
    const e = wheel(svgOf(pres[2]), { ctrlKey: true });
    assert.equal(e.defaultPrevented, true);
    assert.match(svgOf(pres[2]).style.transform, /scale\(/);
  });

  it('a diagram not drawn yet gets the listener once it has its SVG', () => {
    root.innerHTML = '<div class="rm-mermaid"><pre class="mermaid" data-src="graph LR; late-->Y">graph LR; late--&gt;Y</pre></div>';
    mod.decorateDiagrams(root);
    const [pre] = diagrams();
    assert.equal(wheel(pre, { ctrlKey: true }).defaultPrevented, false);
    pre.innerHTML = '<svg id="late"></svg>';
    mod.decorateDiagrams(root);
    assert.equal(wheel(svgOf(pre), { ctrlKey: true }).defaultPrevented, true);
  });
});
