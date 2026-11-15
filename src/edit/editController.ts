import type * as vscode from 'vscode';
import type { EditError, ToWebview } from '../protocol';
import type { RenderResult } from '../render/markdown';
import type { applyBlockEdit, moveListItemEdit, readBlock, toggleTask } from './blockEdit';
import { isRenderedBlock, isRenderedListMove, isRenderedTaskLine } from './rendered';

/** What the edit handlers need from the preview panel they serve. */
export interface EditHost {
  /** The settings read at the time of each request (they can change between requests). */
  settings(): { editEnabled: boolean; editSaveOnCommit: boolean };
  /** The bound document, reopened if VS Code closed it; undefined if it cannot be reopened. */
  liveDocument(): Promise<vscode.TextDocument | undefined>;
  /**
   * The render the webview is showing and the document version it was rendered from (what the webview cites in
   * its edit requests); undefined before the first render. Read when a request is checked, not cached.
   */
  lastRender(): { result: RenderResult; docVersion: number } | undefined;
  /** Posts to the webview (dropped while it is not ready or the panel is disposed). */
  post(message: ToWebview): void;
  /** Renders at once and posts even if the inputs are unchanged (see `afterEdit`). */
  renderAfterEdit(): Promise<void>;
  /** True if a tab shows the bound document and so displays its unsaved state. */
  isShownInEditor(): boolean;
  /** Saves the document. */
  save(doc: vscode.TextDocument): Promise<void>;
  /** Reports an unexpected error of the post-edit work or of an edit operation (error message only, never contents). */
  logError(task: string, error: unknown): void;
}

/**
 * The operations that read or change the document (`edit/blockEdit.ts`). They need `vscode.WorkspaceEdit`, so the
 * controller receives them instead of importing them; the types are derived from the real functions.
 */
export interface EditOps {
  readBlock: typeof readBlock;
  applyBlockEdit: typeof applyBlockEdit;
  toggleTask: typeof toggleTask;
  moveListItemEdit: typeof moveListItemEdit;
}

type Prepared = { doc: vscode.TextDocument } | { error: EditError };

/**
 * Handles the in-preview edit requests of one panel (`requestBlockSource`, `editBlock`, `toggleTask`,
 * `moveListItem`): checks them against the last render, applies them to the document and replies. Every request
 * gets exactly one reply, whatever fails on the way.
 */
export class EditController {
  constructor(
    private readonly host: EditHost,
    private readonly ops: EditOps,
  ) {}

  /**
   * Why an edit request is refused before touching the document, or undefined if `isRendered` accepts the
   * ranges of the render the webview is showing. Edit requests carry ranges from `data-line*` attributes, which
   * raw HTML in the document could forge, so a range is only honoured if the renderer produced it for exactly
   * the document version the request cites: no render of that version (the preview is behind or ahead of the
   * document) = `stale`, like the version check in `edit/blockEdit.ts`; a range the render never produced =
   * `invalid`.
   */
  private checkRendered(doc: vscode.TextDocument, docVersion: number, isRendered: (render: RenderResult) => boolean): EditError | undefined {
    const last = this.host.lastRender();
    if (!last || last.docVersion !== docVersion || doc.version !== docVersion) return 'stale';
    return isRendered(last.result) ? undefined : 'invalid';
  }

  /**
   * The document to edit, or the error to reply with: edit disabled, the document cannot be reopened (or
   * reopening throws) = `failed`, else the `checkRendered` verdict.
   */
  private async prepare(docVersion: number, isRendered: (render: RenderResult) => boolean): Promise<Prepared> {
    try {
      const doc = this.host.settings().editEnabled ? await this.host.liveDocument() : undefined;
      if (!doc) return { error: 'failed' };
      const error = this.checkRendered(doc, docVersion, isRendered);
      return error ? { error } : { doc };
    } catch (e) {
      this.host.logError('Preparing an edit', e);
      return { error: 'failed' };
    }
  }

  /** Runs an edit operation; one that throws instead of returning a result is reported as `failed`. */
  private async attempt<R extends { ok: boolean }>(task: string, run: () => Promise<R>): Promise<R | { ok: false; error: 'failed' }> {
    try {
      return await run();
    } catch (e) {
      this.host.logError(task, e);
      return { ok: false, error: 'failed' };
    }
  }

  async sendBlockSource(start: number, end: number, docVersion: number): Promise<void> {
    // Always reply: the webview waits for the source before opening the editor.
    const prepared = await this.prepare(docVersion, (r) => isRenderedBlock(r.topBlocks, start, end));
    let result: ReturnType<EditOps['readBlock']>;
    if ('error' in prepared) result = { error: prepared.error };
    else {
      try {
        result = this.ops.readBlock(prepared.doc, start, end, docVersion);
      } catch (e) {
        this.host.logError('Reading a block', e);
        result = { error: 'failed' };
      }
    }
    this.host.post({ type: 'blockSource', start, end, docVersion, ...result });
  }

  async editBlock(start: number, end: number, docVersion: number, text: string): Promise<void> {
    // Always reply: the webview keeps the block editor in its saving state until it hears back.
    const prepared = await this.prepare(docVersion, (r) => isRenderedBlock(r.topBlocks, start, end));
    const result = 'error' in prepared
      ? ({ ok: false, error: prepared.error } as const)
      : await this.attempt('Editing a block', () => this.ops.applyBlockEdit(prepared.doc, start, end, docVersion, text));
    if (result.ok && 'doc' in prepared) await this.afterEdit(prepared.doc);
    this.host.post({ type: 'editResult', start, end, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  async setTaskChecked(line: number, checked: boolean, docVersion: number): Promise<void> {
    // Always reply: the webview locks its checkboxes until it hears back.
    const prepared = await this.prepare(docVersion, (r) => isRenderedTaskLine(r.taskLines, line));
    const result = 'error' in prepared
      ? ({ ok: false, error: prepared.error } as const)
      : await this.attempt('Toggling a task', () => this.ops.toggleTask(prepared.doc, line, checked, docVersion));
    if (result.ok && 'doc' in prepared) await this.afterEdit(prepared.doc);
    this.host.post({ type: 'taskResult', line, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  async moveListItem(starts: number[], end: number, from: number, to: number, docVersion: number): Promise<void> {
    // Always reply: the webview has already reordered the list and puts it back on failure.
    const prepared = await this.prepare(docVersion, (r) => isRenderedListMove(r.lists, starts, end));
    const result = 'error' in prepared
      ? ({ ok: false, error: prepared.error } as const)
      : await this.attempt('Moving a list item', () => this.ops.moveListItemEdit(prepared.doc, starts, end, from, to, docVersion));
    if (result.ok && 'doc' in prepared) await this.afterEdit(prepared.doc);
    this.host.post(result.ok ? { type: 'moveResult', ok: true, line: result.line } : { type: 'moveResult', ok: false, error: result.error });
  }

  /**
   * The work after an edit was applied. Never throws: the edit itself succeeded, so the caller reports `ok: true`
   * whatever happens here. A failed immediate render is caught up by the change listener's normal render; a
   * failed save leaves the document dirty (and visible as such). The two are independent, so a render failure
   * does not skip the save.
   */
  private async afterEdit(doc: vscode.TextDocument): Promise<void> {
    // Render right away instead of waiting for the change listener's debounce. Always post: the webview reorders
    // or toggles its DOM optimistically and relies on this render (before the result message) to settle it,
    // even if the edit left the text unchanged.
    try {
      await this.host.renderAfterEdit();
    } catch (e) {
      this.host.logError('Rendering after an edit', e);
    }
    try {
      if (doc.isDirty && !doc.isUntitled && (this.host.settings().editSaveOnCommit || !this.host.isShownInEditor())) {
        // A document not shown in any text editor would otherwise hold an unsaved edit nobody sees.
        await this.host.save(doc);
      }
    } catch (e) {
      this.host.logError('Saving after an edit', e);
    }
  }
}
