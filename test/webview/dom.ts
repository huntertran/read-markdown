// Installs a jsdom window as the global DOM for one test file, so webview modules (browser
// code) can run under mocha in Node. Host-side tests never see these globals: they are added in
// `before` and removed in `after`. Usage inside a test file:
//   describe('x', () => { useDom(); it(...) })
// A file that needs more globals than the default list (for example `navigator`, which Node also
// defines, so the jsdom one replaces it for the file and the original is restored afterwards):
//   describe('x', () => { useDom({ globals: ['navigator'] }); it(...) })
import { JSDOM } from 'jsdom';

/** DOM globals the webview modules touch. */
const GLOBALS = [
  'window',
  'document',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTemplateElement',
  'DocumentFragment',
  'Text',
  'NodeFilter',
  'Range',
  'MutationObserver',
] as const;

export interface UseDomOptions {
  /** Extra window properties to install as globals, on top of the default list. Restored in `after`. */
  globals?: readonly string[];
}

export function useDom(options: UseDomOptions = {}): void {
  let dom: JSDOM | undefined;
  const saved = new Map<string, PropertyDescriptor | undefined>();

  before(() => {
    dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    const win = dom.window;
    const source = win as unknown as Record<string, unknown>;
    for (const name of [...GLOBALS, ...(options.globals ?? [])]) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { value: name === 'window' ? win : source[name], configurable: true, writable: true });
    }
  });

  beforeEach(() => {
    dom?.window.document.body.replaceChildren();
  });

  after(() => {
    for (const [name, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    saved.clear();
    dom?.window.close();
    dom = undefined;
  });
}
