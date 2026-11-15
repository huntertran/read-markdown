import * as assert from 'node:assert/strict';
import type { DocChanges, ToWebview, UiConfig } from '../../src/protocol';
import {
  type HighlightMessage,
  RENDER_DEBOUNCE_MS,
  RenderCoordinator,
  type RenderDocument,
  type RenderHost,
  type Timers,
} from '../../src/preview/renderCoordinator';
import { createMarkdownRenderer } from '../../src/render/markdown';

const markdown = createMarkdownRenderer();

const ORIGINAL = '# Title\n\nfirst\n\nsecond\n';
const EDITED = '# Title\n\nfirst changed\n\nsecond\n';

type HostSettings = ReturnType<RenderHost['settings']>;
type RenderMessage = Extract<ToWebview, { type: 'render' }>;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Timers that only run when the test says so. */
class FakeTimers implements Timers {
  private nextId = 1;
  private readonly pending = new Map<number, () => void>();
  /** The delay of every timer started. */
  readonly delays: number[] = [];

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, callback);
    this.delays.push(ms);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get count(): number {
    return this.pending.size;
  }

  /** Fires every pending timer (the debounce elapsed). */
  runAll(): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const callback of due) callback();
  }
}

/** The mutable world the fake host reads: document, git index, settings, panel and editor state. */
interface World {
  visible: boolean;
  text: string;
  version: number;
  /** false: the document cannot be reopened (`liveDocument` resolves undefined); 'reject': it throws. */
  document: true | false | 'reject';
  original: string | undefined;
  settings: HostSettings;
  /** The visible source editor; undefined if none. */
  editor: { topLine: number; term: string } | undefined;
}

interface Setup {
  coordinator: RenderCoordinator;
  timers: FakeTimers;
  world: World;
  posted: ToWebview[];
  /** Host calls in order: `liveDocument`, `getOriginal`, `render:source` / `render:original`, `config`, `highlight`. */
  calls: string[];
  errors: string[];
  /** Makes the next `liveDocument` wait until the returned deferred is resolved. */
  holdDocument(): Deferred;
  /** Makes the next `getOriginal` wait until the returned deferred is resolved. */
  holdOriginal(): Deferred;
}

function setup(world: Partial<World> = {}): Setup {
  const w: World = {
    visible: true,
    text: EDITED,
    version: 1,
    document: true,
    original: ORIGINAL,
    editor: undefined,
    ...world,
    settings: { mermaid: true, agentProgress: true, changesMode: 'inline', scrollSync: true, searchSyncSelection: true, ...world.settings },
  };
  const posted: ToWebview[] = [];
  const calls: string[] = [];
  const errors: string[] = [];
  const timers = new FakeTimers();
  let docHold: Deferred | undefined;
  let originalHold: Deferred | undefined;
  // Live, like a `vscode.TextDocument`: text and version are read when the coordinator asks.
  const doc: RenderDocument = {
    getText: () => w.text,
    get version() {
      return w.version;
    },
  };
  const host: RenderHost = {
    isVisible: () => w.visible,
    liveDocument: async () => {
      calls.push('liveDocument');
      const hold = docHold;
      docHold = undefined;
      if (hold) await hold.promise;
      if (w.document === 'reject') throw new Error('cannot reopen');
      return w.document ? doc : undefined;
    },
    settings: () => w.settings,
    getOriginal: async () => {
      calls.push('getOriginal');
      const hold = originalHold;
      originalHold = undefined;
      if (hold) await hold.promise;
      return w.original;
    },
    render: (source, options) => {
      calls.push(source === w.original && source !== w.text ? 'render:original' : 'render:source');
      return markdown(source, options);
    },
    resolveResource: (p) => `webview:${p}`,
    postMessage: (message) => {
      posted.push(message);
    },
    configMessage: () => {
      calls.push('config');
      return Promise.resolve({ type: 'config', css: '', customCss: '', ui: {} as UiConfig });
    },
    sourceEditor: () => {
      const editor = w.editor;
      if (!editor) return undefined;
      return {
        topLine: () => editor.topLine,
        highlight: (): HighlightMessage => {
          calls.push('highlight');
          // Located against the render the coordinator holds when the highlight is computed.
          const lines = coordinator.blockLines;
          return { type: 'highlight', term: editor.term, caseSensitive: false, blockLine: lines[lines.length - 1] ?? -1, occurrence: 0 };
        },
      };
    },
    logError: (task, error) => {
      errors.push(`${task}: ${error instanceof Error ? error.message : String(error)}`);
    },
  };
  const coordinator = new RenderCoordinator(host, timers);
  return {
    coordinator,
    timers,
    world: w,
    posted,
    calls,
    errors,
    holdDocument: () => (docHold = deferred()),
    holdOriginal: () => (originalHold = deferred()),
  };
}

/** Lets pending promise chains settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A coordinator whose webview sent `ready` (and got its first content); `posted` and `calls` are cleared. */
async function ready(world: Partial<World> = {}): Promise<Setup> {
  const s = setup(world);
  await s.coordinator.onReady();
  s.posted.length = 0;
  s.calls.length = 0;
  return s;
}

function types(posted: readonly ToWebview[]): string[] {
  return posted.map((m) => m.type);
}

function renders(posted: readonly ToWebview[]): RenderMessage[] {
  return posted.filter((m): m is RenderMessage => m.type === 'render');
}

function onlyRender(posted: readonly ToWebview[]): RenderMessage {
  const found = renders(posted);
  assert.equal(found.length, 1, `one render posted, got ${found.length}`);
  return found[0];
}

function changesOf(posted: readonly ToWebview[]): DocChanges | undefined {
  return onlyRender(posted).changes;
}

const pipelineCalls = (calls: readonly string[]): string[] =>
  calls.filter((c) => c === 'liveDocument' || c === 'getOriginal' || c.startsWith('render:'));

describe('RenderCoordinator', () => {
  describe('before ready', () => {
    it('posts nothing and runs no pipeline before the webview is ready', async () => {
      const s = setup({ editor: { topLine: 3, term: 'first' } });
      s.coordinator.scheduleRender();
      s.timers.runAll();
      await s.coordinator.render();
      await s.coordinator.renderAfterEdit();
      await s.coordinator.sendConfig();
      await s.coordinator.onNeedBaseline(1);
      s.coordinator.scrollToLine(5);
      s.coordinator.highlight(() => ({ type: 'highlight', term: 'x', caseSensitive: false, blockLine: 0, occurrence: 0 }));
      s.coordinator.clearHighlight();
      s.coordinator.post({ type: 'toggleChanges' });
      await flush();
      assert.deepEqual(s.posted, []);
      assert.deepEqual(pipelineCalls(s.calls), []);
      assert.equal(s.coordinator.lastRender(), undefined);
      assert.deepEqual(s.coordinator.blockLines, []);
    });

    it('sends config, then the render, then the scroll line, then the highlight on ready', async () => {
      const s = setup({ editor: { topLine: 3, term: 'first' } });
      await s.coordinator.onReady();
      assert.deepEqual(types(s.posted), ['config', 'render', 'scrollToLine', 'highlight']);
      assert.deepEqual(s.posted[2], { type: 'scrollToLine', line: 3 });
      assert.deepEqual(s.calls.slice(0, 2), ['config', 'liveDocument'], 'config is fetched before the render starts');
    });

    it('computes the highlight on ready against the fresh render', async () => {
      const s = setup({ editor: { topLine: 0, term: 'first' } });
      await s.coordinator.onReady();
      const highlight = s.posted[3];
      assert.equal(highlight.type, 'highlight');
      assert.equal(highlight.blockLine, 4, 'the last block line of the render just posted');
    });

    it('renders on ready even when the panel is hidden', async () => {
      const s = setup({ visible: false, editor: { topLine: 3, term: 'first' } });
      await s.coordinator.onReady();
      assert.deepEqual(types(s.posted), ['config', 'render', 'scrollToLine', 'highlight']);
    });

    it('scrolls to a line requested before ready instead of the editor top line, once', async () => {
      const s = setup({ editor: { topLine: 3, term: 'first' } });
      s.coordinator.scrollToLine(42);
      s.coordinator.scrollToLine(43);
      await s.coordinator.onReady();
      assert.deepEqual(s.posted[2], { type: 'scrollToLine', line: 43 });
      s.coordinator.reload();
      s.posted.length = 0;
      await s.coordinator.onReady();
      assert.deepEqual(s.posted[2], { type: 'scrollToLine', line: 3 }, 'the pending line was used up');
    });

    it('sends a pending line even without an editor or scroll sync', async () => {
      const s = setup({ settings: { scrollSync: false } as HostSettings });
      s.coordinator.scrollToLine(7);
      await s.coordinator.onReady();
      assert.deepEqual(types(s.posted), ['config', 'render', 'scrollToLine']);
    });

    it('sends no scroll or highlight on ready without a visible editor', async () => {
      const s = setup();
      await s.coordinator.onReady();
      assert.deepEqual(types(s.posted), ['config', 'render']);
    });

    it('sends no scroll with scroll sync off and no highlight with search sync off', async () => {
      const noScroll = setup({ editor: { topLine: 3, term: 'first' }, settings: { scrollSync: false } as HostSettings });
      await noScroll.coordinator.onReady();
      assert.deepEqual(types(noScroll.posted), ['config', 'render', 'highlight']);
      const noHighlight = setup({ editor: { topLine: 3, term: 'first' }, settings: { searchSyncSelection: false } as HostSettings });
      await noHighlight.coordinator.onReady();
      assert.deepEqual(types(noHighlight.posted), ['config', 'render', 'scrollToLine']);
      assert.ok(!noHighlight.calls.includes('highlight'), 'not even computed');
    });

    it('posts scrolls and config directly once ready', async () => {
      const s = await ready();
      s.coordinator.scrollToLine(9);
      await s.coordinator.sendConfig();
      assert.deepEqual(s.posted, [
        { type: 'scrollToLine', line: 9 },
        { type: 'config', css: '', customCss: '', ui: {} },
      ]);
    });

    it('posts nothing between a reload and the next ready, and keeps a scroll requested meanwhile', async () => {
      const s = await ready({ editor: { topLine: 3, term: 'first' } });
      s.coordinator.reload();
      s.world.text = 'changed';
      s.world.version++;
      await s.coordinator.render();
      s.coordinator.scrollToLine(11);
      s.coordinator.post({ type: 'toggleChanges' });
      await s.coordinator.sendConfig();
      assert.deepEqual(s.posted, []);
      assert.deepEqual(pipelineCalls(s.calls), []);
      await s.coordinator.onReady();
      assert.deepEqual(types(s.posted), ['config', 'render', 'scrollToLine', 'highlight']);
      assert.deepEqual(s.posted[2], { type: 'scrollToLine', line: 11 });
    });
  });

  describe('hidden panel', () => {
    it('only marks a scheduled render as pending: no timer, no document read, no git read, no Markdown render', async () => {
      const s = await ready({ visible: false });
      s.coordinator.scheduleRender();
      assert.equal(s.timers.count, 0);
      await flush();
      assert.deepEqual(s.calls, []);
      assert.deepEqual(s.posted, []);
    });

    it('only marks a direct render as pending, and drops the debounce timer', async () => {
      const s = await ready();
      s.coordinator.scheduleRender();
      assert.equal(s.timers.count, 1);
      s.world.visible = false;
      s.world.text = 'changed';
      await s.coordinator.render();
      assert.equal(s.timers.count, 0);
      assert.deepEqual(s.calls, []);
      assert.deepEqual(s.posted, []);
    });

    it('renders once when shown, then re-sends the highlight', async () => {
      const s = await ready({ visible: false, editor: { topLine: 0, term: 'first' } });
      s.world.text = 'changed\n\nagain\n';
      s.world.version++;
      s.coordinator.scheduleRender();
      s.coordinator.scheduleRender();
      await s.coordinator.render();
      s.world.visible = true;
      s.coordinator.onShown();
      await flush();
      assert.deepEqual(types(s.posted), ['render', 'highlight']);
      assert.equal(s.calls.filter((c) => c === 'liveDocument').length, 1);
      const highlight = s.posted[1];
      assert.equal(highlight.type, 'highlight');
      assert.equal(highlight.blockLine, 2, 'located against the render just posted');
    });

    it('re-sends the highlight on show even if it equals the one posted before', async () => {
      // The webview's highlight may be stale after the re-render, so the dedupe key is reset.
      const s = setup({ editor: { topLine: 0, term: 'first' } });
      await s.coordinator.onReady();
      const before = s.posted[3];
      s.posted.length = 0;
      s.world.visible = false;
      s.world.text = EDITED.replace('second', 'second edited'); // same blocks, so the same highlight
      s.world.version++;
      s.coordinator.scheduleRender();
      s.world.visible = true;
      s.coordinator.onShown();
      await flush();
      assert.deepEqual(types(s.posted), ['render', 'highlight']);
      assert.deepEqual(s.posted[1], before);
    });

    it('does nothing on show when no render is pending', async () => {
      const s = await ready({ editor: { topLine: 0, term: 'first' } });
      s.coordinator.onShown();
      await flush();
      assert.deepEqual(s.posted, []);
      assert.deepEqual(s.calls, []);
    });

    it('sends no highlight on show when the render was deferred again meanwhile', async () => {
      const s = await ready({ visible: false, editor: { topLine: 0, term: 'first' } });
      s.world.text = 'changed';
      s.coordinator.scheduleRender();
      s.world.visible = true;
      const hold = s.holdDocument();
      s.coordinator.onShown();
      await flush();
      // Hidden again while the render reads the document, and a change arrives.
      s.world.visible = false;
      s.coordinator.scheduleRender();
      hold.resolve();
      await flush();
      assert.deepEqual(types(s.posted), ['render']);
      assert.ok(!s.calls.includes('highlight'));
    });

    it('sends no highlight on show when the panel was hidden again before the render ran', async () => {
      const s = await ready({ visible: false, editor: { topLine: 0, term: 'first' } });
      s.coordinator.scheduleRender();
      s.coordinator.onShown(); // a view-state event, but the panel is not visible (any more)
      await flush();
      assert.deepEqual(s.posted, []);
      assert.deepEqual(s.calls, []);
    });

    it('still clears the posted highlight after a show whose render was deferred again', async () => {
      // The webview keeps showing the highlight, so turning search sync off must still clear it.
      const s = setup({ editor: { topLine: 0, term: 'first' } });
      await s.coordinator.onReady();
      s.posted.length = 0;
      s.world.visible = false;
      s.coordinator.scheduleRender();
      s.coordinator.onShown(); // not visible (any more): the render is deferred again
      await flush();
      s.coordinator.clearHighlight();
      assert.deepEqual(s.posted, [{ type: 'highlight', term: '', caseSensitive: false, blockLine: 0, occurrence: 0 }]);
    });

    it('sends no highlight on show without an editor or with search sync off', async () => {
      for (const world of [{}, { editor: { topLine: 0, term: 'first' }, settings: { searchSyncSelection: false } as HostSettings }]) {
        const s = await ready({ visible: false, ...world });
        s.world.text = 'changed';
        s.coordinator.scheduleRender();
        s.world.visible = true;
        s.coordinator.onShown();
        await flush();
        assert.deepEqual(types(s.posted), ['render']);
      }
    });

    it('skips a highlight while a render is pending, without computing it', async () => {
      const s = await ready({ visible: false });
      s.coordinator.scheduleRender();
      let computed = false;
      s.coordinator.highlight(() => {
        computed = true;
        return { type: 'highlight', term: 'x', caseSensitive: false, blockLine: 0, occurrence: 0 };
      });
      assert.equal(computed, false);
      assert.deepEqual(s.posted, []);
    });

    it('logs a failed render on show', async () => {
      const s = await ready({ visible: false });
      s.coordinator.scheduleRender();
      s.world.visible = true;
      s.world.document = 'reject';
      s.coordinator.onShown();
      await flush();
      assert.deepEqual(s.errors, ['Rendering after show: cannot reopen']);
    });
  });

  describe('identical renders', () => {
    it('skips a render with unchanged inputs without the Markdown or diff work', async () => {
      const s = await ready();
      await s.coordinator.render();
      assert.deepEqual(s.posted, []);
      assert.deepEqual(s.calls, ['liveDocument', 'getOriginal'], 'no Markdown render');
    });

    const changes: { input: string; change: (w: World) => void }[] = [
      { input: 'source', change: (w) => (w.text = `${w.text}\nmore\n`) },
      { input: 'original', change: (w) => (w.original = '# Title\n\nzero\n') },
      { input: 'docVersion', change: (w) => w.version++ },
      { input: 'mermaid', change: (w) => (w.settings.mermaid = false) },
      { input: 'activeTasks', change: (w) => (w.settings.agentProgress = false) },
      { input: 'changesMode', change: (w) => (w.settings.changesMode = 'gutter') },
    ];
    for (const { input, change } of changes) {
      it(`posts when only ${input} changed`, async () => {
        const s = await ready();
        change(s.world);
        await s.coordinator.render();
        onlyRender(s.posted);
      });
    }

    it('posts after an edit even if the inputs are unchanged', async () => {
      const s = await ready();
      await s.coordinator.renderAfterEdit();
      onlyRender(s.posted);
      s.posted.length = 0;
      await s.coordinator.render();
      assert.deepEqual(s.posted, [], 'the next identical render is skipped again');
    });

    it('posts on every ready even if the inputs are unchanged', async () => {
      const s = await ready();
      s.coordinator.reload();
      await s.coordinator.onReady();
      onlyRender(s.posted);
    });

    it('posts the render after an edit while hidden once shown', async () => {
      const s = await ready({ visible: false });
      await s.coordinator.renderAfterEdit();
      assert.deepEqual(s.posted, []);
      s.world.visible = true;
      s.coordinator.onShown();
      await flush();
      onlyRender(s.posted);
    });
  });

  describe('races', () => {
    it('drops an older render still reading the document when a newer one posted', async () => {
      const s = await ready();
      const hold = s.holdDocument();
      s.world.text = 'older';
      const older = s.coordinator.render();
      await flush();
      s.world.text = 'newer';
      s.world.version = 5;
      await s.coordinator.render();
      hold.resolve();
      await older;
      const posted = onlyRender(s.posted);
      assert.match(posted.html, /newer/);
      assert.equal(s.coordinator.lastRender()?.docVersion, 5);
    });

    it('drops an older render still reading the git baseline when a newer one posted', async () => {
      const s = await ready();
      const hold = s.holdOriginal();
      s.world.text = 'older';
      s.world.version = 4;
      const older = s.coordinator.render();
      await flush();
      s.world.text = 'newer';
      s.world.version = 5;
      await s.coordinator.render();
      hold.resolve();
      await older;
      assert.match(onlyRender(s.posted).html, /newer/);
      assert.match(s.coordinator.lastRender()?.result.html ?? '', /newer/);
    });

    it('drops the older render even when the newer one finds nothing to post', async () => {
      // The newer render sees the inputs already posted and skips; the older one must not post its stale text.
      const s = await ready();
      const hold = s.holdDocument();
      const older = s.coordinator.render();
      await flush();
      await s.coordinator.render();
      s.world.text = 'meanwhile';
      hold.resolve();
      await older;
      assert.deepEqual(s.posted, []);
    });
  });

  describe('debounce', () => {
    it('turns several scheduled renders within the debounce into one', async () => {
      const s = await ready();
      s.world.text = 'changed';
      s.coordinator.scheduleRender();
      s.coordinator.scheduleRender();
      s.coordinator.scheduleRender();
      assert.equal(s.timers.count, 1);
      assert.deepEqual(s.timers.delays, [RENDER_DEBOUNCE_MS, RENDER_DEBOUNCE_MS, RENDER_DEBOUNCE_MS]);
      assert.equal(RENDER_DEBOUNCE_MS, 250);
      assert.deepEqual(s.posted, [], 'nothing before the debounce elapsed');
      s.timers.runAll();
      await flush();
      onlyRender(s.posted);
      assert.equal(s.calls.filter((c) => c === 'liveDocument').length, 1);
    });

    it('drops the timer when a render runs now', async () => {
      const s = await ready();
      s.world.text = 'changed';
      s.coordinator.scheduleRender();
      await s.coordinator.render();
      assert.equal(s.timers.count, 0);
      onlyRender(s.posted);
    });

    it('drops the timer on reload and on dispose', async () => {
      const s = await ready();
      s.coordinator.scheduleRender();
      s.coordinator.reload();
      assert.equal(s.timers.count, 0);
      await s.coordinator.onReady();
      s.coordinator.scheduleRender();
      s.coordinator.dispose();
      assert.equal(s.timers.count, 0);
    });

    it('logs a failed debounced render', async () => {
      const s = await ready();
      s.world.document = 'reject';
      s.coordinator.scheduleRender();
      s.timers.runAll();
      await flush();
      assert.deepEqual(s.errors, ['Rendering: cannot reopen']);
    });
  });

  describe('baseline', () => {
    it('sends the original HTML with the first render that shows changes', async () => {
      const s = setup();
      await s.coordinator.onReady();
      const changes = changesOf(s.posted);
      assert.ok(changes?.originalHtml);
      assert.match(changes.originalHtml, /first/);
      assert.ok(changes.ops.length > 0);
    });

    it('sends only the id and the ops while the webview holds the baseline', async () => {
      const s = setup();
      await s.coordinator.onReady();
      const first = changesOf(s.posted);
      s.posted.length = 0;
      s.world.text = `${EDITED}\nmore\n`;
      s.world.version++;
      await s.coordinator.render();
      const second = changesOf(s.posted);
      assert.ok(second);
      assert.deepEqual(Object.keys(second).sort(), ['baselineId', 'ops']);
      assert.equal(second.baselineId, first?.baselineId);
    });

    it('renders the original once per baseline', async () => {
      const s = setup();
      await s.coordinator.onReady();
      s.world.text = `${EDITED}\nmore\n`;
      await s.coordinator.render();
      s.world.settings.changesMode = 'gutter';
      await s.coordinator.render();
      assert.equal(s.calls.filter((c) => c === 'render:original').length, 1);
      assert.equal(s.calls.filter((c) => c === 'render:source').length, 3);
    });

    it('sends the HTML again after ready (the reloaded webview has no baseline)', async () => {
      const s = setup();
      await s.coordinator.onReady();
      const first = changesOf(s.posted);
      s.posted.length = 0;
      await s.coordinator.onReady();
      const again = changesOf(s.posted);
      assert.ok(again?.originalHtml);
      assert.equal(again.baselineId, first?.baselineId, 'same baseline, not re-rendered');
    });

    it('sends the HTML again after a reload', async () => {
      const s = setup();
      await s.coordinator.onReady();
      s.posted.length = 0;
      s.coordinator.reload();
      await s.coordinator.onReady();
      assert.ok(changesOf(s.posted)?.originalHtml);
    });

    it('sends the HTML again after a render without changes (the webview released its copy)', async () => {
      const s = setup();
      await s.coordinator.onReady();
      const first = changesOf(s.posted);
      s.posted.length = 0;
      s.world.text = ORIGINAL;
      await s.coordinator.render();
      assert.equal(changesOf(s.posted), undefined);
      s.posted.length = 0;
      s.world.text = EDITED;
      s.world.version++;
      await s.coordinator.render();
      const again = changesOf(s.posted);
      assert.ok(again?.originalHtml);
      assert.equal(again.baselineId, first?.baselineId);
    });

    it('re-sends the render with the HTML when the webview misses the baseline it holds', async () => {
      const s = setup();
      await s.coordinator.onReady();
      const id = changesOf(s.posted)?.baselineId;
      assert.ok(id !== undefined);
      s.posted.length = 0;
      s.calls.length = 0;
      await s.coordinator.onNeedBaseline(id);
      const again = changesOf(s.posted);
      assert.ok(again?.originalHtml, 'sent although the inputs are unchanged');
      assert.equal(again.baselineId, id);
      assert.ok(!s.calls.includes('render:original'), 'from the cached original render');
    });

    it('ignores a missing-baseline report for an id that is not the one sent last', async () => {
      const s = setup();
      await s.coordinator.onReady();
      const id = changesOf(s.posted)?.baselineId;
      assert.ok(id !== undefined);
      s.posted.length = 0;
      await s.coordinator.onNeedBaseline(id + 1);
      await s.coordinator.onNeedBaseline(id - 1);
      assert.deepEqual(s.posted, []);
      // A superseded baseline: the original moved on, the webview's late report cites the old id.
      s.world.original = '# Title\n\nzero\n';
      await s.coordinator.render();
      s.posted.length = 0;
      await s.coordinator.onNeedBaseline(id);
      assert.deepEqual(s.posted, []);
    });

    it('ignores a missing-baseline report when no baseline was sent', async () => {
      const s = setup({ original: undefined });
      await s.coordinator.onReady();
      s.posted.length = 0;
      await s.coordinator.onNeedBaseline(1);
      assert.deepEqual(s.posted, []);
    });

    it('defers the re-send of a missing baseline while hidden, then sends the HTML on show', async () => {
      const s = setup();
      await s.coordinator.onReady();
      const id = changesOf(s.posted)?.baselineId;
      assert.ok(id !== undefined);
      s.posted.length = 0;
      s.world.visible = false;
      await s.coordinator.onNeedBaseline(id);
      assert.deepEqual(s.posted, []);
      s.world.visible = true;
      s.coordinator.onShown();
      await flush();
      assert.ok(changesOf(s.posted)?.originalHtml);
    });

    it('uses a new baseline id when the original, mermaid or activeTasks changes, and never reuses one', async () => {
      const s = setup();
      await s.coordinator.onReady();
      const ids = [changesOf(s.posted)?.baselineId];
      const steps: ((w: World) => void)[] = [
        (w) => (w.original = '# Title\n\nzero\n\nsecond\n'),
        (w) => (w.settings.mermaid = false),
        (w) => (w.settings.agentProgress = false),
        (w) => (w.settings.mermaid = true), // back to an earlier combination: still a new id
        (w) => (w.original = ORIGINAL),
      ];
      for (const step of steps) {
        s.posted.length = 0;
        step(s.world);
        await s.coordinator.render();
        const changes = changesOf(s.posted);
        assert.ok(changes?.originalHtml, 'a new baseline travels with its HTML');
        ids.push(changes.baselineId);
      }
      assert.deepEqual(ids, [1, 2, 3, 4, 5, 6]);
    });

    it('keeps the baseline id when only the source, the version or the changes mode changes', async () => {
      const s = setup();
      await s.coordinator.onReady();
      const id = changesOf(s.posted)?.baselineId;
      for (const step of [(w: World) => (w.text = `${EDITED}x\n`), (w: World) => w.version++, (w: World) => (w.settings.changesMode = 'gutter')]) {
        s.posted.length = 0;
        step(s.world);
        await s.coordinator.render();
        assert.equal(changesOf(s.posted)?.baselineId, id);
      }
    });
  });

  describe('changes dropped', () => {
    it('shows no changes when the original differs from the source only in line endings', async () => {
      const s = setup({ text: ORIGINAL.replace(/\n/g, '\r\n') });
      await s.coordinator.onReady();
      assert.equal(changesOf(s.posted), undefined);
      assert.ok(!s.calls.includes('render:original'), 'the original is not rendered');
    });

    it('shows no changes when the source equals the original', async () => {
      const s = setup({ text: ORIGINAL });
      await s.coordinator.onReady();
      assert.equal(changesOf(s.posted), undefined);
    });

    it('shows no changes without an original', async () => {
      const s = setup({ original: undefined });
      await s.coordinator.onReady();
      assert.equal(changesOf(s.posted), undefined);
    });

    it('shows no changes with the changes mode off, without asking for the original', async () => {
      const s = setup({ settings: { changesMode: 'off' } as HostSettings });
      await s.coordinator.onReady();
      assert.equal(changesOf(s.posted), undefined);
      assert.ok(!s.calls.includes('getOriginal'));
    });

    it('shows no changes when the block diff finds none', async () => {
      // Different text, same top-level blocks: only the blank lines at the end differ.
      const s = setup({ text: `${ORIGINAL}\n\n` });
      await s.coordinator.onReady();
      assert.ok(s.calls.includes('render:original'), 'the diff ran');
      assert.equal(changesOf(s.posted), undefined);
    });
  });

  describe('document version and last render', () => {
    it('posts the version read together with the text', async () => {
      const s = await ready();
      s.world.text = 'read text';
      s.world.version = 10;
      const hold = s.holdOriginal();
      const rendering = s.coordinator.render();
      await flush();
      assert.ok(s.calls.includes('getOriginal'), 'the text was read');
      s.world.text = 'later text';
      s.world.version = 11;
      hold.resolve();
      await rendering;
      const posted = onlyRender(s.posted);
      assert.equal(posted.docVersion, 10);
      assert.match(posted.html, /read text/);
      assert.equal(s.coordinator.lastRender()?.docVersion, 10);
    });

    it('updates the last render exactly when a render is posted', async () => {
      const s = setup();
      assert.equal(s.coordinator.lastRender(), undefined);
      await s.coordinator.onReady();
      const first = s.coordinator.lastRender();
      assert.ok(first);
      assert.equal(first.docVersion, 1);
      assert.equal(first.result.html, onlyRender(s.posted).html);
      assert.deepEqual(s.coordinator.blockLines, first.result.blockLines);
      // A skipped identical render keeps it.
      await s.coordinator.render();
      assert.equal(s.coordinator.lastRender()?.result, first.result);
      // A render that cannot read the document keeps it.
      s.world.document = false;
      s.world.version = 2;
      await s.coordinator.render();
      assert.equal(s.coordinator.lastRender()?.result, first.result);
      // A posted one replaces it.
      s.world.document = true;
      s.posted.length = 0;
      await s.coordinator.render();
      assert.equal(s.coordinator.lastRender()?.docVersion, 2);
      assert.equal(s.coordinator.lastRender()?.result.html, onlyRender(s.posted).html);
    });

    it('passes the resource resolver to the renderer, for the source and the original', async () => {
      const s = setup({ text: '![a](a.png)\n', original: '![b](b.png)\n' });
      await s.coordinator.onReady();
      const posted = onlyRender(s.posted);
      assert.match(posted.html, /webview:a\.png/);
      assert.match(posted.changes?.originalHtml ?? '', /webview:b\.png/);
    });

    it('posts nothing, and does not ask for the original, when the document cannot be reopened', async () => {
      const s = setup({ document: false });
      await s.coordinator.onReady();
      assert.deepEqual(types(s.posted), ['config']);
      assert.ok(!s.calls.includes('getOriginal'));
    });
  });

  describe('dispose', () => {
    it('posts nothing after dispose', async () => {
      const s = await ready();
      s.coordinator.dispose();
      s.world.text = 'changed';
      await s.coordinator.render();
      await s.coordinator.renderAfterEdit();
      s.coordinator.scrollToLine(1);
      s.coordinator.post({ type: 'toggleChanges' });
      await s.coordinator.sendConfig();
      s.coordinator.reload();
      await s.coordinator.onReady();
      assert.deepEqual(s.posted, []);
      assert.deepEqual(pipelineCalls(s.calls), []);
    });

    it('does not ask for the original when disposed while reading the document', async () => {
      const s = await ready();
      s.world.text = 'changed';
      const hold = s.holdDocument();
      const rendering = s.coordinator.render();
      await flush();
      s.coordinator.dispose();
      hold.resolve();
      await rendering;
      assert.deepEqual(s.calls, ['liveDocument']);
      assert.deepEqual(s.posted, []);
    });

    it('posts nothing and keeps the last render when disposed while reading the original', async () => {
      const s = await ready();
      const before = s.coordinator.lastRender();
      s.world.text = 'changed';
      const hold = s.holdOriginal();
      const rendering = s.coordinator.render();
      await flush();
      s.coordinator.dispose();
      hold.resolve();
      await rendering;
      assert.deepEqual(s.posted, []);
      assert.equal(s.coordinator.lastRender()?.result, before?.result);
      assert.ok(!s.calls.some((c) => c.startsWith('render:')));
    });
  });

  describe('highlight', () => {
    const message = (term: string): HighlightMessage => ({ type: 'highlight', term, caseSensitive: false, blockLine: 0, occurrence: 0 });

    it('does not post the same highlight twice in a row', async () => {
      const s = await ready();
      s.coordinator.highlight(() => message('a'));
      s.coordinator.highlight(() => message('a'));
      s.coordinator.highlight(() => message('b'));
      s.coordinator.highlight(() => message('a'));
      assert.deepEqual(s.posted, [message('a'), message('b'), message('a')]);
    });

    it('posts the same highlight again after ready', async () => {
      const s = await ready();
      s.coordinator.highlight(() => message('a'));
      s.coordinator.reload();
      await s.coordinator.onReady();
      s.posted.length = 0;
      s.coordinator.highlight(() => message('a'));
      assert.deepEqual(s.posted, [message('a')]);
    });

    it('clears only a highlight that was posted, once', async () => {
      const s = await ready();
      s.coordinator.clearHighlight();
      assert.deepEqual(s.posted, [], 'nothing to clear');
      s.coordinator.highlight(() => message('a'));
      s.coordinator.clearHighlight();
      s.coordinator.clearHighlight();
      assert.deepEqual(s.posted, [message('a'), message('')]);
      s.posted.length = 0;
      s.coordinator.highlight(() => message('a'));
      assert.deepEqual(s.posted, [message('a')], 'posted again after the clear');
    });

    it('clears a highlight even while a render is pending', async () => {
      const s = await ready();
      s.coordinator.highlight(() => message('a'));
      s.world.visible = false;
      s.coordinator.scheduleRender();
      s.coordinator.clearHighlight();
      assert.deepEqual(s.posted, [message('a'), message('')]);
    });
  });
});
