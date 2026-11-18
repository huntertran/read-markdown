// Runs the whole webview (`webview/app.ts`, what `main.ts` starts) in jsdom on the real preview shell,
// for tests of the entry point's wiring. Call `usePreview()` in the top `describe` instead of `useDom`,
// `useVsCodeApi` and `useLayout` (it registers them, in that order, then its own hooks):
//
//   describe('x', () => {
//     const preview = usePreview();
//     it('renders', () => {
//       preview.send(configMessage());
//       preview.send(renderMessage('# Title'));
//       assert.ok(preview.content.querySelector('h1'));
//     });
//   });
//
// The shell is the HTML template of `src/preview/html.ts` (read from the source file: the module imports
// `vscode`), its `${…}` expressions dropped and its script left out. The preview is started ONCE per file in
// `before` (its listeners and the other modules' init calls cannot be undone), so the module state of the
// webview (last config, last render, open editor, baseline, search term) carries over from test to test:
// every test sends the config and render it needs. `useDom` empties `<body>` before every test; the shell
// (and whatever the modules appended to `<body>` at start) is put back right after.
//
// Stubbed, because jsdom has no layout or these APIs: `requestAnimationFrame` (queued, run by
// `frames.run()`), `setTimeout`/`clearTimeout` during each test (queued, run by `timers.run()`; real
// between tests), `CSS.highlights` + `Highlight` (search), `CSS.escape`, `window.matchMedia` (reduced
// motion on, so nothing calls the missing `Element.animate`), `Element.scrollIntoView` and
// `Range.getBoundingClientRect`. Mermaid is never loaded: keep `mermaid: false` in the config.
import { diffDocument } from '../../src/diff/blockDiff';
import type { FromWebview, ToWebview, UiConfig, WebviewState } from '../../src/protocol';
import { createMarkdownRenderer } from '../../src/render/markdown';
import type { RenderStages } from '../../webview/app';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useDom } from './dom';
import { type LayoutHandle, useLayout } from './layout';
import { type VsCodeApiHandle, useVsCodeApi } from './vscodeApi';

export type RenderMessage = Extract<ToWebview, { type: 'render' }>;
export type ConfigMessage = Extract<ToWebview, { type: 'config' }>;

/** Stand-in for the CSS Custom Highlight API's `Highlight`: remembers its ranges. */
export class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

/** A queue of callbacks the test runs itself (fake `requestAnimationFrame` / `setTimeout`). */
export interface CallbackQueue {
  /** Callbacks scheduled and not yet run or cancelled. */
  readonly pending: number;
  /** Runs every queued callback, including ones queued while running (up to a bound). */
  run(): void;
}

export interface PreviewHandle {
  readonly vscode: VsCodeApiHandle;
  readonly layout: LayoutHandle;
  /** What the preview posted while starting (before the first test's `beforeEach` cleared `vscode.posted`). */
  readonly postedAtStart: readonly FromWebview[];
  /** The webview state right after start. */
  readonly stateAtStart: WebviewState | undefined;
  /** `#rm-content`. */
  readonly content: HTMLElement;
  /**
   * Delivers a host message the way VS Code does (a `message` event on `window`), synchronously. Throws what
   * a listener threw (jsdom only reports listener exceptions to the window's `error` event).
   */
  send(msg: ToWebview): void;
  /** `target.dispatchEvent(event)`, rethrowing what a listener threw. Returns false if the default was prevented. */
  dispatch(target: EventTarget, event: Event): boolean;
  readonly frames: CallbackQueue;
  readonly timers: CallbackQueue;
  /** The registry behind the stubbed `CSS.highlights`. */
  readonly highlights: Map<string, FakeHighlight>;
}

export interface PreviewOptions {
  /** Replaces the render stages (e.g. wraps the real ones to record calls); default `RENDER_STAGES`. */
  stages?: (real: RenderStages) => RenderStages;
}

const SHELL_TEMPLATE = /return \/\* html \*\/ `([\s\S]*?)`;/;

/** The shell markup of `src/preview/html.ts`, without its `${…}` values. */
export function shellHtml(): string {
  const source = readFileSync(join(process.cwd(), 'src', 'preview', 'html.ts'), 'utf8');
  const m = SHELL_TEMPLATE.exec(source);
  if (!m) throw new Error('shell template not found in src/preview/html.ts');
  return m[1].replace(/\$\{[^}]*\}/g, '');
}

function queue(): CallbackQueue & { add(fn: () => void): number; remove(id: number): void; clear(): void } {
  const callbacks = new Map<number, () => void>();
  let nextId = 0;
  return {
    get pending() {
      return callbacks.size;
    },
    add(fn) {
      callbacks.set(++nextId, fn);
      return nextId;
    },
    remove(id) {
      callbacks.delete(id);
    },
    clear() {
      callbacks.clear();
    },
    run() {
      for (let round = 0; callbacks.size && round < 20; round++) {
        const batch = [...callbacks];
        callbacks.clear();
        for (const [, fn] of batch) fn();
      }
    },
  };
}

export function usePreview(options: PreviewOptions = {}): PreviewHandle {
  // `navigator`: editBlock.ts reads `navigator.platform` at import (Node has its own, which can say Mac).
  // `getComputedStyle`: the list-item grip and the change gutter call it unqualified; `Option`: the
  // settings panel builds its selects with it.
  useDom({ globals: ['navigator', 'getComputedStyle', 'Option'] });
  const vscode = useVsCodeApi();
  const layout = useLayout();

  const frames = queue();
  const timers = queue();
  const highlights = new Map<string, FakeHighlight>();
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
  const realTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let shellNodes: Node[] = [];
  let postedAtStart: FromWebview[] = [];
  let stateAtStart: WebviewState | undefined;
  let content: HTMLElement | undefined;
  /** Exceptions thrown by event listeners during the current test (see `send`). */
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    errors.push(e.error);
    e.preventDefault(); // handled here, not logged by jsdom
  };

  function rethrow(): void {
    if (errors.length) throw errors.splice(0)[0];
  }

  function dispatch(target: EventTarget, event: Event): boolean {
    const result = target.dispatchEvent(event);
    rethrow();
    return result;
  }

  function stubGlobal(name: string, value: unknown): void {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  before(async () => {
    stubGlobal('requestAnimationFrame', (fn: () => void) => frames.add(fn));
    stubGlobal('cancelAnimationFrame', (id: number) => frames.remove(id));
    // search.ts decides at import time whether the Highlight API exists.
    stubGlobal('CSS', { highlights, escape: (s: string) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) });
    stubGlobal('Highlight', FakeHighlight);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    const elementProto = window.Element.prototype as unknown as Record<string, unknown>;
    elementProto.scrollIntoView = () => {};
    const rangeProto = window.Range.prototype as unknown as Record<string, unknown>;
    rangeProto.getBoundingClientRect = () => ({ top: 100, bottom: 120, left: 0, right: 0, x: 0, y: 100, width: 0, height: 20 });

    // The real shell: head styles the config writes into, then the body.
    const shell = new window.DOMParser().parseFromString(shellHtml(), 'text/html');
    for (const style of shell.head.querySelectorAll('style[id]')) document.head.append(document.importNode(style, true));
    for (const attr of shell.body.attributes) document.body.setAttribute(attr.name, attr.value);
    document.body.dataset.uri = 'file:///doc.md';
    for (const node of shell.body.childNodes) if (!(node instanceof window.HTMLScriptElement)) document.body.append(document.importNode(node, true));

    const app = await import('../../webview/app');
    app.startPreview(options.stages ? options.stages(app.RENDER_STAGES) : app.RENDER_STAGES);
    postedAtStart = [...vscode.posted];
    stateAtStart = vscode.state && { ...vscode.state };
    shellNodes = [...document.body.childNodes];
    content = document.getElementById('rm-content') ?? undefined;
  });

  beforeEach(() => {
    // useDom's beforeEach has emptied <body>.
    document.body.replaceChildren(...shellNodes);
    frames.clear();
    timers.clear();
    globalThis.setTimeout = ((fn: () => void) => timers.add(fn)) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => timers.remove(id)) as unknown as typeof clearTimeout;
    errors.length = 0;
    window.addEventListener('error', onError);
  });

  afterEach(() => {
    globalThis.setTimeout = realTimers.setTimeout;
    globalThis.clearTimeout = realTimers.clearTimeout;
    window.removeEventListener('error', onError);
    // Listener exceptions of events the test dispatched itself (a plain `el.click()`, `frames.run()`).
    rethrow();
  });

  after(() => {
    for (const [name, desc] of savedGlobals) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    savedGlobals.clear();
  });

  return {
    vscode,
    layout,
    get postedAtStart() {
      return postedAtStart;
    },
    get stateAtStart() {
      return stateAtStart;
    },
    get content() {
      if (!content) throw new Error('preview not started');
      return content;
    },
    send: (msg) => {
      dispatch(window, new window.MessageEvent('message', { data: msg }));
    },
    dispatch,
    frames,
    timers,
    highlights,
  };
}

// ---- messages ----------------------------------------------------------------------------------

export const UI_DEFAULTS: UiConfig = {
  navShow: true,
  navPosition: 'left',
  navMaxDepth: 6,
  preset: 'vscode',
  scheme: 'light',
  headingHighlight: 'none',
  copyButton: true,
  codeLineNumbers: true,
  mermaid: false,
  mermaidTheme: 'auto',
  mermaidLook: 'classic',
  collapsible: true,
  startCollapsedBelowLevel: 0,
  scrollSync: true,
  sourceLineNumbers: false,
  fontSize: 16,
  lineHeight: 1.6,
  maxWidth: 900,
  fullWidth: false,
  headingScale: 1,
  tableHeaderBackgroundColor: '',
  tableHeaderTextColor: '',
  editable: false,
  editDoubleClick: false,
  changesMode: 'inline',
  agentProgress: true,
  taskProgress: true,
};

export function configMessage(ui: Partial<UiConfig> = {}, css = ':root { --rm-test: 1; }'): ConfigMessage {
  return { type: 'config', css, customCss: '', ui: { ...UI_DEFAULTS, ...ui } };
}

const renderer = createMarkdownRenderer();

export interface RenderMessageOptions {
  docVersion?: number;
  /** Track changes against this original (git index) text. */
  original?: string;
  baselineId?: number;
  /** Send `originalHtml` (default true); false = cite the baseline id only. */
  withBaseline?: boolean;
}

/** A `render` message as the extension builds it: the real renderer, and the real diff for changes. */
export function renderMessage(markdown: string, opts: RenderMessageOptions = {}): RenderMessage {
  const current = renderer(markdown, { mermaid: true });
  const msg: RenderMessage = {
    type: 'render',
    html: current.html,
    headings: current.headings,
    hasMermaid: current.hasMermaid,
    docVersion: opts.docVersion ?? 1,
  };
  if (opts.original === undefined) return msg;
  const original = renderer(opts.original, { mermaid: true });
  const ops = diffDocument(original.topBlocks, current.topBlocks);
  if (!ops) throw new Error('diffDocument returned no ops');
  const baselineId = opts.baselineId ?? 1;
  msg.changes = opts.withBaseline === false ? { baselineId, ops } : { baselineId, originalHtml: original.html, ops };
  return msg;
}

/** A `render` message with hand-written HTML (what a compromised or buggy host could send). */
export function rawRenderMessage(html: string, docVersion = 1): RenderMessage {
  return { type: 'render', html, headings: [], hasMermaid: false, docVersion };
}
