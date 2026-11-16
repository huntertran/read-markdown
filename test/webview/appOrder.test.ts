import * as assert from 'node:assert/strict';
import type { RenderStages } from '../../webview/app';
import { configMessage, renderMessage, usePreview } from './preview';

// The call order of the render stages in webview/app.ts, for the steps whose order has no effect jsdom can
// show (app.test.ts proves the security- and order-sensitive parts by their effect). The real stages run,
// wrapped to record their names; only `renderMermaid` is a stub (Mermaid is not loaded under jsdom).
const calls: string[] = [];

function recording(real: RenderStages): RenderStages {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(real) as [string, (...args: unknown[]) => unknown][]) {
    wrapped[name] = (...args: unknown[]) => {
      calls.push(name);
      return fn(...args);
    };
  }
  wrapped.renderMermaid = () => {
    calls.push('renderMermaid');
    return Promise.resolve();
  };
  return wrapped as unknown as RenderStages;
}

const ALL = [
  'sanitize',
  'baselineFor',
  'applyChanges',
  'buildSections',
  'decorateCodeBlocks',
  'applyTableWidths',
  'stampMenuContext',
  'syncTaskCheckboxes',
  'setHeadings',
  'updateTaskProgress',
  'reapplySearch',
  'scheduleChangeGutter',
  'renderMermaid',
];

const ORIGINAL = '# Doc\n\nOld text.\n\n```mermaid\ngraph TD; A-->B\n```\n';
const CURRENT = '# Doc\n\nNew text.\n\n```mermaid\ngraph TD; A-->B\n```\n';

describe('webview render stage order', () => {
  const preview = usePreview({ stages: recording });
  let baseline: typeof import('../../webview/baseline');

  before(async () => {
    baseline = await import('../../webview/baseline');
  });

  beforeEach(() => {
    baseline.resetBaseline();
    preview.send(configMessage({ mermaid: true }));
    calls.length = 0;
  });

  it('runs every stage once, in order', () => {
    const msg = renderMessage(CURRENT, { original: ORIGINAL });
    assert.equal(msg.hasMermaid, true);
    preview.send(msg);
    assert.deepEqual(calls, ALL);
  });

  it('skips applyChanges without the baseline, and the baseline lookup without changes', () => {
    preview.send(renderMessage(CURRENT, { original: ORIGINAL, withBaseline: false }));
    assert.deepEqual(
      calls,
      ALL.filter((s) => s !== 'applyChanges'),
    );
    calls.length = 0;
    preview.send(renderMessage(CURRENT, { docVersion: 2 }));
    assert.deepEqual(
      calls,
      ALL.filter((s) => s !== 'applyChanges' && s !== 'baselineFor'),
    );
  });

  it('skips the baseline lookup while changes are off', () => {
    preview.send(configMessage({ mermaid: true, changesMode: 'off' }));
    // Other headings: the render below cannot be patched onto this one, so it runs in full.
    preview.send(renderMessage('# Other\n'));
    calls.length = 0;
    preview.send(renderMessage(CURRENT, { original: ORIGINAL }));
    assert.deepEqual(
      calls,
      ALL.filter((s) => s !== 'applyChanges' && s !== 'baselineFor'),
    );
  });

  it('patches a render that changes no heading: sanitizes and decorates only the new block, keeps the sections', () => {
    preview.send(renderMessage('# Other\n'));
    preview.send(renderMessage(CURRENT, { docVersion: 2 }));
    calls.length = 0;
    preview.send(renderMessage(CURRENT.replace('New text.', 'Newer text.'), { docVersion: 3 }));
    assert.deepEqual(
      calls,
      ALL.filter((s) => s !== 'baselineFor' && s !== 'applyChanges' && s !== 'buildSections'),
    );
  });

  it('runs no stage for a render held back by an open editor, and all of them when it closes', () => {
    preview.send(configMessage({ mermaid: true, editable: true }));
    preview.send(renderMessage('para\n'));
    preview.send({ type: 'startEdit', line: 0 });
    preview.send({ type: 'blockSource', start: 0, end: 1, docVersion: 1, text: 'para' });
    calls.length = 0;
    preview.send(renderMessage(CURRENT, { original: ORIGINAL, docVersion: 2 }));
    assert.deepEqual(calls, []);
    preview.content.querySelector<HTMLElement>('button.rm-edit-cancel')!.click();
    assert.deepEqual(calls, ALL);
    preview.send(configMessage({ mermaid: true }));
  });

  it('re-renders on a config change that needs it, and only redraws diagrams otherwise', () => {
    preview.send(renderMessage(CURRENT));
    calls.length = 0;
    preview.send(configMessage({ mermaid: true, navMaxDepth: 2 }));
    assert.deepEqual(
      calls,
      ALL.filter((s) => s !== 'applyChanges' && s !== 'baselineFor'),
    );
    calls.length = 0;
    preview.send(configMessage({ mermaid: true, navMaxDepth: 2, mermaidTheme: 'forest' }));
    assert.deepEqual(calls, ['renderMermaid']);
    calls.length = 0;
    preview.send(configMessage({ mermaid: false, navMaxDepth: 2 }));
    assert.deepEqual(calls, [], 'no diagrams to redraw with Mermaid off');
  });
});
