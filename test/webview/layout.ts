// Stubs for what jsdom has no layout for, so webview modules that read geometry and time can run
// under mocha: a controllable clock (`performance.now`), `window.scrollY` / `scrollTo` /
// `innerHeight`, element rectangles, and a `ResizeObserver` whose callbacks the test fires itself.
// Call `useLayout()` in the top `describe`, AFTER `useDom()` (it needs the window) and before any hook
// that lazily imports the module under test (mocha runs hooks in registration order):
//
//   describe('x', () => {
//     useDom();
//     const layout = useLayout();
//     before(async () => { mod = await import('../../webview/scroll'); });
//     it('...', () => {
//       layout.place(el, 400);        // el sits 400px from the top of the document
//       layout.scrollY = 100;         // el.getBoundingClientRect().top is now 300
//       layout.advance(150);          // performance.now() moves 150 ms on
//     });
//   });
//
// The clock only moves through `advance`, and never goes back between tests (modules keep
// timestamps in module state, so a clock that jumped back would revive their old windows). The
// scroll position, the recorded `scrollTo` calls and the observers are reset before every test.
// `performance.now` and the `ResizeObserver` global are restored in `after`; everything set on the
// jsdom window disappears with it.

export interface LayoutHandle {
  /** The page's vertical scroll offset (`window.scrollY`); `window.scrollTo` sets it. */
  scrollY: number;
  /** `window.innerHeight`. */
  innerHeight: number;
  /** Every `window.scrollTo({ top, behavior })` call since the start of the test. */
  readonly scrolls: { top: number; behavior: string | undefined }[];
  /** The fake `performance.now()`. */
  now(): number;
  /** Moves the clock on by `ms`. */
  advance(ms: number): void;
  /**
   * Gives `el` a position: `top` is the absolute offset from the top of the document (its rect top
   * is `top - scrollY`, so it follows scrolling). `undefined` = not rendered (no client rects, as
   * inside a collapsed section). Can be called again to move the element.
   */
  place(el: HTMLElement, top: number | undefined, height?: number): void;
  /** Elements passed to `observe()` of a live fake `ResizeObserver` since the start of the test. */
  readonly observed: Element[];
  /** Runs the callback of every observer (or only those observing `target`) with a content width. */
  resize(width: number, target?: Element): void;
}

type ObserverCallback = (entries: { target: Element; contentRect: { width: number; height: number } }[], observer: unknown) => void;

export function useLayout(): LayoutHandle {
  let clock = 1_000_000;
  const observers: { callback: ObserverCallback; targets: Element[] }[] = [];
  const handle: LayoutHandle = {
    scrollY: 0,
    innerHeight: 800,
    scrolls: [],
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    place: (el, top, height = 20) => {
      el.getClientRects = () => (top === undefined ? [] : [rect(top - handle.scrollY, height)]) as unknown as DOMRectList;
      el.getBoundingClientRect = () => rect((top ?? 0) - handle.scrollY, top === undefined ? 0 : height);
    },
    get observed() {
      return observers.flatMap((o) => o.targets);
    },
    resize: (width, target) => {
      for (const o of [...observers]) {
        const targets = target ? o.targets.filter((t) => t === target) : o.targets;
        if (targets.length === 0) continue;
        o.callback(
          targets.map((t) => ({ target: t, contentRect: { width, height: 0 } })),
          o,
        );
      }
    },
  };
  let savedNow: PropertyDescriptor | undefined;
  let savedObserver: PropertyDescriptor | undefined;

  before(() => {
    savedNow = Object.getOwnPropertyDescriptor(performance, 'now');
    Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => clock });
    savedObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    class FakeResizeObserver {
      private readonly entry: { callback: ObserverCallback; targets: Element[] };
      constructor(callback: ObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element): void {
        this.entry.targets.push(target);
      }
      unobserve(target: Element): void {
        this.entry.targets = this.entry.targets.filter((t) => t !== target);
      }
      disconnect(): void {
        const i = observers.indexOf(this.entry);
        if (i >= 0) observers.splice(i, 1);
      }
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: FakeResizeObserver });
    // The window exists (useDom's `before` ran first); it is closed in useDom's `after`.
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => handle.scrollY });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => handle.innerHeight });
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      writable: true,
      value: (options: ScrollToOptions) => {
        handle.scrolls.push({ top: options.top ?? 0, behavior: options.behavior });
        handle.scrollY = options.top ?? 0;
      },
    });
  });

  beforeEach(() => {
    handle.scrollY = 0;
    handle.innerHeight = 800;
    handle.scrolls.length = 0;
    observers.length = 0;
  });

  after(() => {
    // `performance.now` is inherited by Node's `performance`; give back exactly what was there.
    if (savedNow) Object.defineProperty(performance, 'now', savedNow);
    else delete (performance as unknown as Record<string, unknown>).now;
    if (savedObserver) Object.defineProperty(globalThis, 'ResizeObserver', savedObserver);
    else delete (globalThis as Record<string, unknown>).ResizeObserver;
    observers.length = 0;
  });

  return handle;
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 0, x: 0, y: top, width: 0, height, toJSON: () => ({}) };
}
