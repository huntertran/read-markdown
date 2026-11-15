// The render pipeline of one preview panel: when the webview is sent content, what is skipped as identical,
// which render wins a race, which baseline travels, and the order of the messages after `ready`. Pure (no
// `vscode` import; everything VS Code-bound comes in through `RenderHost`) so it runs under plain mocha.
import type { Settings } from '../config/settings';
import { diffDocument } from '../diff/blockDiff';
import type { DocChanges, ToWebview } from '../protocol';
import type { RenderOptions, RenderResult } from '../render/markdown';
import { BaselineSync } from './baselineSync';

export const RENDER_DEBOUNCE_MS = 250;

export type HighlightMessage = Extract<ToWebview, { type: 'highlight' }>;

/** What a render reads from the bound document: text and version, read together. */
export interface RenderDocument {
  getText(): string;
  readonly version: number;
}

/** The source editor showing the document, for the scroll and highlight sent after `ready` and after a show. */
export interface SourceEditor {
  /** The editor's first visible line. */
  topLine(): number;
  /** The highlight for the editor's selection, computed against the current `blockLines`. */
  highlight(): HighlightMessage;
}

/** A timer source; the default is the global `setTimeout`/`clearTimeout`. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What the coordinator needs from the panel it serves. */
export interface RenderHost {
  /** True while the panel is visible. */
  isVisible(): boolean;
  /** The bound document, reopened if VS Code closed it; undefined if it cannot be reopened. */
  liveDocument(): Promise<RenderDocument | undefined>;
  /** The settings, read once per render (they can change between renders). */
  settings(): Pick<Settings, 'mermaid' | 'agentProgress' | 'changesMode' | 'scrollSync' | 'searchSyncSelection'>;
  /** The document's git index version (undefined: none). */
  getOriginal(): Promise<string | undefined>;
  /** The shared Markdown renderer. */
  render(source: string, options: RenderOptions): RenderResult;
  /** Rewrites a relative resource path to a webview URI (`RenderOptions.resolveResource`). */
  resolveResource(path: string): string | undefined;
  /** Posts to the webview; the coordinator only calls it while the webview is ready and not disposed. */
  postMessage(message: ToWebview): void;
  /** The current `config` message. */
  configMessage(): Promise<ToWebview>;
  /** The visible text editor of the document, or undefined if none shows it. */
  sourceEditor(): SourceEditor | undefined;
  /** Reports a rejected background render (error message only, never contents). */
  logError(task: string, error: unknown): void;
}

const globalTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function eolNormalized(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** The render state of one panel's webview and the messages that depend on it. */
export class RenderCoordinator {
  private ready = false;
  private disposed = false;
  private renderTimer: unknown;
  private lastRenderResult: RenderResult | undefined;
  /** Document version `lastRenderResult` was rendered from (what the webview shows, and cites in its edit requests). */
  private lastRenderVersion = -1;
  /** The git index version last rendered for change display, with the inputs it was rendered from. */
  private originalRender:
    | { original: string; mermaid: boolean; activeTasks: boolean | undefined; result: RenderResult; id: number }
    | undefined;
  /** Source of `DocChanges.baselineId`: bumped whenever `originalRender` is replaced, never reused. */
  private baselineSeq = 0;
  /** Which baseline this panel's webview holds; reset whenever the webview (re)loads. */
  private readonly baselineSync = new BaselineSync();
  /**
   * Inputs of the last render posted to the webview. An identical render would replace the DOM with the same
   * content (a save fires the text change, the file watcher and a git state change), so it is skipped.
   * Cleared whenever the webview needs a post regardless (it has no content, or an edit awaits its re-render).
   */
  private posted:
    | {
        source: string;
        original: string | undefined;
        /** Part of the message: the webview sends it back with edits, which are rejected when stale. */
        docVersion: number;
        mermaid: boolean;
        activeTasks: boolean;
        /** The webview does not re-render when this setting alone changes; it relies on the extension's post. */
        changesMode: string;
      }
    | undefined;
  /** Bumped per render so a slower, older render never overwrites a newer one. */
  private renderSeq = 0;
  /** The last highlight message posted (JSON), so an identical one is not posted again; '' = none. */
  private lastHighlightKey = '';
  /** A scroll requested before the webview was ready; sent after its first render. */
  private pendingLine: number | undefined;
  /** A render was requested while the panel was hidden; it runs once when the panel is shown again. */
  private renderPending = false;

  constructor(
    private readonly host: RenderHost,
    private readonly timers: Timers = globalTimers,
  ) {}

  /** The render the webview is showing and the document version it was rendered from; undefined before the first. */
  lastRender(): { result: RenderResult; docVersion: number } | undefined {
    return this.lastRenderResult ? { result: this.lastRenderResult, docVersion: this.lastRenderVersion } : undefined;
  }

  get blockLines(): readonly number[] {
    return this.lastRenderResult?.blockLines ?? [];
  }

  /** Posts to the webview; dropped while it is not ready or after dispose. */
  post(message: ToWebview): void {
    if (this.ready && !this.disposed) this.host.postMessage(message);
  }

  private clearTimer(): void {
    if (this.renderTimer !== undefined) this.timers.clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
  }

  // ---- webview lifecycle -----------------------------------------------------------------

  /**
   * The webview (re)loaded and asks for content: config, then the render, then the scroll line and the highlight.
   * It renders even if the panel is hidden (e.g. restored in a background tab): this is the webview's first
   * content, and it keeps `lastRender` fresh for the scroll/highlight messages.
   */
  async onReady(): Promise<void> {
    this.ready = true;
    this.lastHighlightKey = '';
    // A (re)loaded webview has no content, whatever was posted to its predecessor.
    this.posted = undefined;
    this.baselineSync.forget();
    await this.sendConfig();
    await this.renderNow();
    const editor = this.host.sourceEditor();
    const settings = this.host.settings();
    if (this.pendingLine !== undefined) {
      this.post({ type: 'scrollToLine', line: this.pendingLine });
      this.pendingLine = undefined;
    } else if (editor && settings.scrollSync) {
      this.post({ type: 'scrollToLine', line: editor.topLine() });
    }
    if (editor && settings.searchSyncSelection) this.highlight(() => editor.highlight());
  }

  /** The webview HTML is being rebuilt: nothing is posted until the new page sends `ready`. */
  reload(): void {
    if (this.disposed) return;
    this.ready = false;
    this.baselineSync.forget();
    this.clearTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /** The panel became visible: catch up on a render deferred while it was hidden. */
  onShown(): void {
    if (this.renderPending) this.renderOnShow().catch((e: unknown) => this.host.logError('Rendering after show', e));
  }

  async sendConfig(): Promise<void> {
    if (!this.ready) return;
    this.post(await this.host.configMessage());
  }

  /**
   * The webview cited baseline `id` without holding it (safety net; it asks once per id). Sends the render again,
   * this time with the HTML, even though its inputs are unchanged.
   */
  async onNeedBaseline(id: number): Promise<void> {
    if (this.baselineSync.missing(id)) {
      this.posted = undefined;
      await this.render();
    }
  }

  /** Renders and posts even if the inputs are unchanged: the webview settles its optimistic edit on this render. */
  async renderAfterEdit(): Promise<void> {
    this.posted = undefined;
    await this.render();
  }

  // ---- rendering -------------------------------------------------------------------------

  scheduleRender(): void {
    this.clearTimer();
    // The panel keeps its context while hidden, so skip the pipeline and catch up once when it is shown.
    if (!this.host.isVisible()) {
      this.renderPending = true;
      return;
    }
    this.renderTimer = this.timers.setTimeout(() => {
      this.renderTimer = undefined;
      this.render().catch((e: unknown) => this.host.logError('Rendering', e));
    }, RENDER_DEBOUNCE_MS);
  }

  /** Renders now, or, while the panel is hidden, defers to the next time it is shown. */
  async render(): Promise<void> {
    if (!this.ready || this.disposed) return;
    if (!this.host.isVisible()) {
      this.clearTimer();
      this.renderPending = true;
      return;
    }
    await this.renderNow();
  }

  /** The deferred render, then the search highlight, whose block line may have changed meanwhile. */
  private async renderOnShow(): Promise<void> {
    await this.render();
    const editor = this.host.sourceEditor();
    if (this.renderPending || !editor || !this.host.settings().searchSyncSelection) return;
    this.lastHighlightKey = '';
    this.highlight(() => editor.highlight());
  }

  private async renderNow(): Promise<void> {
    if (!this.ready || this.disposed) return;
    this.clearTimer();
    this.renderPending = false;
    const seq = ++this.renderSeq;
    const doc = await this.host.liveDocument();
    // Disposed meanwhile: asking for the baseline now would re-create the entry the manager just released.
    if (!doc || this.disposed) return;
    // Text and version are read together, before any further await, so the posted version matches the text.
    const source = doc.getText();
    const docVersion = doc.version;
    const { mermaid, agentProgress: activeTasks, changesMode } = this.host.settings();
    // Fetched before rendering so an identical render is skipped without the Markdown and diff work.
    const original = changesMode === 'off' ? undefined : await this.host.getOriginal();
    if (seq !== this.renderSeq || this.disposed) return;
    const last = this.posted;
    if (
      last &&
      last.source === source &&
      last.original === original &&
      last.docVersion === docVersion &&
      last.mermaid === mermaid &&
      last.activeTasks === activeTasks &&
      last.changesMode === changesMode
    ) {
      return;
    }
    const options: RenderOptions = { mermaid, activeTasks, resolveResource: (p) => this.host.resolveResource(p) };
    const result = this.host.render(source, options);
    const found = this.changesFor(source, original, result, options);
    // The baseline travels only when the webview does not hold it (claimed here, in the same turn as the post).
    const sendBaseline = this.baselineSync.claim(found?.baselineId);
    const changes: DocChanges | undefined = found && (sendBaseline ? found : { baselineId: found.baselineId, ops: found.ops });
    this.lastRenderResult = result;
    this.lastRenderVersion = docVersion;
    this.posted = { source, original, docVersion, mermaid, activeTasks, changesMode };
    this.post({
      type: 'render',
      html: result.html,
      headings: result.headings,
      hasMermaid: result.hasMermaid,
      docVersion,
      changes,
    });
  }

  /** Changes of `source` against the file's git index version `original` (undefined: none, or not shown). */
  private changesFor(
    source: string,
    original: string | undefined,
    current: RenderResult,
    options: RenderOptions,
  ): (DocChanges & { originalHtml: string }) | undefined {
    if (original === undefined || eolNormalized(original) === eolNormalized(source)) return undefined;
    // Re-render the original when it or a setting that changes rendering changed.
    let cached = this.originalRender;
    if (
      !cached ||
      cached.original !== original ||
      cached.mermaid !== options.mermaid ||
      cached.activeTasks !== options.activeTasks
    ) {
      cached = {
        original,
        mermaid: options.mermaid,
        activeTasks: options.activeTasks,
        result: this.host.render(original, options),
        id: ++this.baselineSeq,
      };
      this.originalRender = cached;
    }
    const ops = diffDocument(cached.result.topBlocks, current.topBlocks);
    return ops?.length ? { baselineId: cached.id, originalHtml: cached.result.html, ops } : undefined;
  }

  // ---- sync ------------------------------------------------------------------------------

  /** Scrolls the webview to source `line`; before `ready`, the line is kept and sent after the first render. */
  scrollToLine(line: number): void {
    if (!this.ready) {
      this.pendingLine = line;
      return;
    }
    this.post({ type: 'scrollToLine', line });
  }

  /**
   * Posts the highlight `compute` returns unless it equals the last one posted. Skipped while a render is deferred:
   * `blockLines` is stale then, and the render on show sends the highlight afterwards.
   */
  highlight(compute: () => HighlightMessage): void {
    if (this.renderPending) return;
    const message = compute();
    const key = JSON.stringify(message);
    if (key === this.lastHighlightKey) return;
    this.lastHighlightKey = key;
    this.post(message);
  }

  /** Clears the webview's highlight, if one was posted. */
  clearHighlight(): void {
    if (!this.lastHighlightKey) return;
    this.lastHighlightKey = '';
    this.post({ type: 'highlight', term: '', caseSensitive: false, blockLine: 0, occurrence: 0 });
  }
}
