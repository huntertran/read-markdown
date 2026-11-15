import * as assert from 'node:assert/strict';
import { useDom } from './dom';

type MermaidModule = typeof import('../../webview/mermaid');

// The script-tag loader of webview/mermaid.ts, in its own file: the module keeps its loader state,
// and mermaid.test.ts needs a loader that always succeeds.
describe('mermaid script load failure', () => {
  useDom();

  let mod: MermaidModule;
  let head: HTMLElement | undefined;
  let win: (Window & { mermaid?: unknown }) | undefined;
  let savedError: typeof console.error;
  /** What the next appended script does: fail to load, load without defining `mermaid`, or load. */
  let outcome: 'error' | 'empty' | 'ok' = 'ok';
  const scripts: HTMLScriptElement[] = [];
  let runs = 0;
  const fake = {
    initialize: () => {},
    run: ({ nodes }: { nodes: ArrayLike<HTMLElement> }) => {
      runs++;
      for (const node of Array.from(nodes)) {
        node.innerHTML = '<svg></svg>';
        node.setAttribute('data-processed', 'true');
      }
      return Promise.resolve();
    },
  };
  const opts = { scheme: 'light', theme: 'default', look: 'classic' } as const;

  before(async () => {
    head = document.head;
    win = window;
    const append = document.head.append.bind(document.head);
    (head as unknown as { append: (...nodes: (Node | string)[]) => void }).append = (...nodes) => {
      append(...nodes);
      for (const node of nodes) {
        if (!(node instanceof Element) || node.tagName !== 'SCRIPT') continue;
        const script = node as HTMLScriptElement;
        scripts.push(script);
        const result = outcome;
        queueMicrotask(() => {
          if (result === 'error') {
            script.onerror?.(new window.Event('error'));
            return;
          }
          if (result === 'ok') window.mermaid = fake;
          script.onload?.(new window.Event('load'));
        });
      }
    };
    // The module reports the failure on the console; keep the test output clean.
    savedError = console.error;
    console.error = () => {};
    mod = await import('../../webview/mermaid');
  });

  after(() => {
    console.error = savedError;
    delete (head as unknown as Record<string, unknown> | undefined)?.append;
    delete win?.mermaid;
  });

  function diagram(): { root: HTMLElement; block: HTMLElement } {
    const root = document.createElement('div');
    root.innerHTML = '<div class="rm-mermaid"><pre class="mermaid">graph TD; a-->b</pre></div>';
    document.body.append(root);
    return { root, block: root.querySelector('pre.mermaid') as HTMLElement };
  }

  it('marks the diagrams when the script fails, and loads it again on the next render', async () => {
    const { root, block } = diagram();

    outcome = 'error';
    await mod.renderMermaid(root, opts);
    assert.equal(block.classList.contains('rm-mermaid-error'), true);
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].isConnected, false, 'the failed script tag is removed');

    // A script that loads but does not define `mermaid` is a failure too.
    outcome = 'empty';
    await mod.renderMermaid(root, opts);
    assert.equal(scripts.length, 2, 'the failure was not cached');
    assert.equal(block.classList.contains('rm-mermaid-error'), true);
    assert.equal(runs, 0);

    outcome = 'ok';
    await mod.renderMermaid(root, opts);
    assert.equal(scripts.length, 3);
    assert.equal(runs, 1);
    assert.equal(block.classList.contains('rm-mermaid-error'), false, 'the error mark is cleared once it is drawn');
    assert.ok(block.querySelector('svg'));

    // Once loaded, the script is kept.
    const again = diagram();
    await mod.renderMermaid(again.root, { ...opts, look: 'neo' });
    assert.equal(scripts.length, 3);
  });
});
