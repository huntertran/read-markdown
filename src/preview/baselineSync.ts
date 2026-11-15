// Tracks which rendered baseline (`DocChanges.baselineId`) one webview holds, so a render only carries
// `originalHtml` when the webview lacks it. Pure (no `vscode`) so it runs under plain mocha.

export class BaselineSync {
  /** Id of the baseline the webview holds; undefined = none (the webview drops it when changes stop being shown). */
  private held: number | undefined;

  /** The webview (re)loaded or lost its copy: the next render with changes must carry the HTML. */
  forget(): void {
    this.held = undefined;
  }

  /**
   * Call once per render that is posted, with the baseline id of its changes (undefined = none). Returns true if the
   * message must include `originalHtml`. The webview releases its copy on a render without changes, so
   * `held` follows that.
   */
  claim(id: number | undefined): boolean {
    const send = id !== undefined && id !== this.held;
    this.held = id;
    return send;
  }

  /**
   * The webview reports that it cited `id` without having it. Returns true if that contradicts what was sent (so the
   * next render must carry the HTML, and the caller should post one); a request for an id that is no longer
   * the current one is a late echo of a render already superseded.
   */
  missing(id: number): boolean {
    if (this.held !== id) return false;
    this.held = undefined;
    return true;
  }
}
