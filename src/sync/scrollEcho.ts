// Echo suppression for the two-way scroll sync (host side). Moving one side makes it report a scroll
// of its own a moment later; without these guards that report would be sent back and the editor and
// the preview would push each other around. Pure (no `vscode` import, injectable clock) so it runs
// under plain mocha; the webview has its own guard in `webview/scroll.ts`.

/** How long after a programmatic scroll the scrolled side's own scroll reports are ignored. */
export const SCROLL_ECHO_MS = 300;

type Clock = () => number;

/** A time window that starts when one side is scrolled programmatically. */
export class EchoWindow {
  private until = 0;

  constructor(
    private readonly now: Clock = Date.now,
    private readonly ms = SCROLL_ECHO_MS,
  ) {}

  /** Call right before scrolling that side: its reports are echoes for the next `ms`. */
  start(): void {
    this.until = this.now() + this.ms;
  }

  /** True while a report from that side is to be ignored (the window ends at exactly `ms`). */
  get active(): boolean {
    return this.now() < this.until;
  }
}

/**
 * Decides which visible-range events of the text editors are scrolls by the user. `Editor` is the
 * `vscode.TextEditor`; entries die with it (WeakMap).
 */
export class EditorScrollGuard<Editor extends object> {
  /**
   * First visible line of each editor at its last event. Edits that replace several lines (e.g.
   * moving a list item from the preview) fire the event although the editor did not scroll; without
   * this check the preview would jump to the editor's top line.
   */
  private readonly topLine = new WeakMap<Editor, number>();
  private readonly echo = new WeakMap<Editor, EchoWindow>();

  constructor(
    private readonly now: Clock = Date.now,
    private readonly ms = SCROLL_ECHO_MS,
  ) {}

  /** Records where a newly shown editor starts, so its first event is compared too. Keeps a known line. */
  seed(editor: Editor, topLine: number): void {
    if (!this.topLine.has(editor)) this.topLine.set(editor, topLine);
  }

  /** Call right before revealing a line in `editor` for the preview: its next events are echoes. */
  expectEcho(editor: Editor): void {
    let window = this.echo.get(editor);
    if (!window) this.echo.set(editor, (window = new EchoWindow(this.now, this.ms)));
    window.start();
  }

  /**
   * A visible-range event of `editor`, now starting at `topLine`. True if the preview should follow:
   * the top line changed and it is not the echo of a reveal. The line is recorded either way.
   */
  scrolled(editor: Editor, topLine: number): boolean {
    const previous = this.topLine.get(editor);
    this.topLine.set(editor, topLine);
    if (topLine === previous) return false;
    return !(this.echo.get(editor)?.active ?? false);
  }
}
