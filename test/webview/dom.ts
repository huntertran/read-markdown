// Installs a happy-dom window as the global DOM for one test file, so webview modules (browser
// code) can run under mocha in Node. Host-side tests never see these globals: they are added in
// `before` and removed in `after`. Usage inside a test file:
//   describe('x', () => { useDom(); it(...) })
import { Window } from 'happy-dom';

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
] as const;

export function useDom(): void {
  let win: Window | undefined;
  const saved = new Map<string, PropertyDescriptor | undefined>();

  before(() => {
    win = new Window();
    const source = win as unknown as Record<string, unknown>;
    for (const name of GLOBALS) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { value: name === 'window' ? win : source[name], configurable: true, writable: true });
    }
  });

  beforeEach(() => {
    win?.document.body.replaceChildren();
  });

  after(() => {
    for (const [name, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    saved.clear();
    void win?.happyDOM.close();
    win = undefined;
  });
}
