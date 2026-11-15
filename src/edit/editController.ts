import * as vscode from 'vscode';
import type { EditError, ToWebview } from '../protocol';
import type { RenderResult } from '../render/markdown';
import { applyBlockEdit, moveListItemEdit, readBlock, toggleTask } from './blockEdit';
import { isRenderedBlock, isRenderedListMove, isRenderedTaskLine } from './rendered';

/** What the edit handlers need from the preview panel they serve. */
export interface EditHost {
  /** The settings read at the time of each request (they can change between requests). */
  settings(): { editEnabled: boolean; editSaveOnCommit: boolean };
  /** The bound document, reopened if VS Code closed it; undefined if it cannot be reopened. */
  liveDocument(): Promise<vscode.TextDocument | undefined>;
  /** URI of the bound document. */
  documentUri(): vscode.Uri;
  /**
   * The render the webview is showing and the document version it was rendered from (what the webview cites in
   * its edit requests); undefined before the first render. Read when a request is checked, not cached.
   */
  lastRender(): { result: RenderResult; docVersion: number } | undefined;
  /** Posts to the webview (dropped while it is not ready or the panel is disposed). */
  post(message: ToWebview): void;
  /** Renders at once and posts even if the inputs are unchanged (see `afterEdit`). */
  renderAfterEdit(): Promise<void>;
}

/**
 * Handles the in-preview edit requests of one panel (`requestBlockSource`, `editBlock`, `toggleTask`,
 * `moveListItem`): checks them against the last render, applies them to the document and replies.
 */
export class EditController {
  constructor(private readonly host: EditHost) {}

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

  async sendBlockSource(start: number, end: number, docVersion: number): Promise<void> {
    // Always reply: the webview waits for the source before opening the editor.
    const doc = this.host.settings().editEnabled ? await this.host.liveDocument() : undefined;
    const error = doc && this.checkRendered(doc, docVersion, (r) => isRenderedBlock(r.topBlocks, start, end));
    const result = !doc ? ({ error: 'failed' } as const) : error ? { error } : readBlock(doc, start, end, docVersion);
    this.host.post({ type: 'blockSource', start, end, docVersion, ...result });
  }

  async editBlock(start: number, end: number, docVersion: number, text: string): Promise<void> {
    const doc = this.host.settings().editEnabled ? await this.host.liveDocument() : undefined;
    const error = doc && this.checkRendered(doc, docVersion, (r) => isRenderedBlock(r.topBlocks, start, end));
    const result = !doc ? ({ ok: false, error: 'failed' } as const) : error ? ({ ok: false, error } as const) : await applyBlockEdit(doc, start, end, docVersion, text);
    if (result.ok && doc) await this.afterEdit(doc);
    this.host.post({ type: 'editResult', start, end, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  async setTaskChecked(line: number, checked: boolean, docVersion: number): Promise<void> {
    // Always reply: the webview locks its checkboxes until it hears back.
    const doc = this.host.settings().editEnabled ? await this.host.liveDocument() : undefined;
    const error = doc && this.checkRendered(doc, docVersion, (r) => isRenderedTaskLine(r.taskLines, line));
    const result = !doc ? ({ ok: false, error: 'failed' } as const) : error ? ({ ok: false, error } as const) : await toggleTask(doc, line, checked, docVersion);
    if (result.ok && doc) await this.afterEdit(doc);
    this.host.post({ type: 'taskResult', line, ok: result.ok, error: result.ok ? undefined : result.error });
  }

  async moveListItem(starts: number[], end: number, from: number, to: number, docVersion: number): Promise<void> {
    // Always reply: the webview has already reordered the list and puts it back on failure.
    const doc = this.host.settings().editEnabled ? await this.host.liveDocument() : undefined;
    const error = doc && this.checkRendered(doc, docVersion, (r) => isRenderedListMove(r.lists, starts, end));
    const result = !doc ? ({ ok: false, error: 'failed' } as const) : error ? ({ ok: false, error } as const) : await moveListItemEdit(doc, starts, end, from, to, docVersion);
    if (result.ok && doc) await this.afterEdit(doc);
    this.host.post(result.ok ? { type: 'moveResult', ok: true, line: result.line } : { type: 'moveResult', ok: false, error: result.error });
  }

  private async afterEdit(doc: vscode.TextDocument): Promise<void> {
    // Render right away instead of waiting for the change listener's debounce. Always post: the webview reorders
    // or toggles its DOM optimistically and relies on this render (before the result message) to settle it,
    // even if the edit left the text unchanged.
    await this.host.renderAfterEdit();
    if (doc.isDirty && !doc.isUntitled && (this.host.settings().editSaveOnCommit || !this.isOpenInTextEditor())) {
      // A document not shown in any text editor would otherwise hold an unsaved edit nobody sees.
      await doc.save();
    }
  }

  /** True if a tab shows this document and so displays its unsaved state. */
  private isOpenInTextEditor(): boolean {
    const uri = this.host.documentUri().toString();
    // The custom editor (`readMarkdown.editor`) shows the dirty state itself, like a text editor.
    return vscode.window.tabGroups.all.some((g) =>
      g.tabs.some(
        (t) => (t.input instanceof vscode.TabInputText || t.input instanceof vscode.TabInputCustom) && t.input.uri.toString() === uri,
      ),
    );
  }
}
