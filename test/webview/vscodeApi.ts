// Stands in for the webview host API (`acquireVsCodeApi()`) for one test file. `webview/api.ts`
// calls it ONCE, at import time, and keeps the result, so the stub has to exist before the module
// under test is imported: call `useVsCodeApi()` in the top `describe` (before any hook that does the
// lazy `await import(...)`; mocha runs hooks in registration order) and read the handle in tests.
//
//   describe('x', () => {
//     useDom();
//     const vscode = useVsCodeApi();
//     before(async () => { mod = await import('../../webview/editBlock'); });
//     it('posts', () => {
//       mod.doSomething();
//       assert.deepEqual(vscode.posted, [{ type: 'ready' }]);
//     });
//   });
//
// The handle's `posted` array is the same object for the whole file and is emptied before every
// test (beforeEach), as is the stored state, so tests start from nothing. State set by the module
// under test (`api.setState`) is readable through `vscode.state`; seed it with `vscode.state = ...`.
// The global is removed again in `after`, so nothing leaks into other test files.
import type { FromWebview, WebviewState } from '../../src/protocol';

export interface VsCodeApiHandle {
  /** Every message the module posted since the start of the current test, oldest first. */
  readonly posted: FromWebview[];
  /** The persisted webview state (`getState`/`setState`); undefined until something sets it. */
  state: WebviewState | undefined;
  /** Forgets the messages posted so far (e.g. after setup that is not under test). */
  clear(): void;
  /** The posted messages of one type, narrowed. */
  postedOfType<T extends FromWebview['type']>(type: T): Extract<FromWebview, { type: T }>[];
}

export function useVsCodeApi(): VsCodeApiHandle {
  const posted: FromWebview[] = [];
  const handle: VsCodeApiHandle = {
    posted,
    state: undefined,
    clear: () => {
      posted.length = 0;
    },
    postedOfType: <T extends FromWebview['type']>(type: T) => posted.filter((m): m is Extract<FromWebview, { type: T }> => m.type === type),
  };
  let saved: PropertyDescriptor | undefined;

  before(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, 'acquireVsCodeApi');
    const api = {
      postMessage: (message: FromWebview) => {
        posted.push(message);
      },
      getState: () => handle.state,
      setState: (state: WebviewState) => {
        handle.state = state;
      },
    };
    Object.defineProperty(globalThis, 'acquireVsCodeApi', { value: () => api, configurable: true, writable: true });
  });

  beforeEach(() => {
    handle.clear();
    handle.state = undefined;
  });

  after(() => {
    if (saved) Object.defineProperty(globalThis, 'acquireVsCodeApi', saved);
    else delete (globalThis as Record<string, unknown>).acquireVsCodeApi;
    saved = undefined;
  });

  return handle;
}
