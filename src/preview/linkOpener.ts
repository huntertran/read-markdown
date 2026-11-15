import type * as vscode from 'vscode';
import { type PathContext, type Reference, resolveReference } from './paths';

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mkdn)$/i;

/** A preview that can scroll to a heading. */
export interface HeadingReveal {
  revealHeading(slug: string): void;
}

/**
 * What link opening needs from the outside world. Every side effect is its own port so a test can record the
 * order of calls; the decisions (which branch, what is asked first, what is shown) are `LinkOpener`'s.
 */
export interface LinkHost {
  /** What `resolveReference` needs to resolve references written in `from`, read from the current workspace. */
  pathContext(from: vscode.Uri): PathContext;
  /** The URI of a local reference (`vscode.Uri.from`; it needs the `vscode` runtime, so it is injected). */
  toUri(ref: Extract<Reference, { kind: 'local' }>): vscode.Uri;
  /** Asks the user whether to open a target outside the allowed roots; true only on an explicit yes. */
  confirm(target: vscode.Uri): Promise<boolean>;
  /** Resolves if the file system has `target`, rejects if not (or if it cannot be read). */
  stat(target: vscode.Uri): Promise<void>;
  /** Shows a non-modal warning; not awaited. */
  warn(message: string): void;
  /** Opens (or reveals) a preview of a Markdown target. */
  openPreview(target: vscode.Uri): Promise<HeadingReveal>;
  /** Opens a non-Markdown target in an editor. */
  openFile(target: vscode.Uri): Promise<void>;
  /** Hands an http, https or mailto link, as written, to the OS. */
  openExternal(href: string): Promise<void>;
  /** Reveals a heading in every preview of the document `from`. */
  revealFragment(from: vscode.Uri, fragment: string): void;
}

/** The texts of the confirmation shown before opening a target outside the allowed roots. */
export function outsideTargetPrompt(target: vscode.Uri): { message: string; detail: string; accept: string } {
  const shown = target.scheme === 'file' ? target.fsPath : target.toString(true);
  return { message: 'This link opens a file outside the workspace.', detail: `The link points to:\n${shown}`, accept: 'Open' };
}

/**
 * Opens the links clicked in a preview. A rejection of `confirm`, `openPreview`, `openFile` or `openExternal`
 * propagates to the caller (a failed `stat` is reported as a missing file instead).
 */
export class LinkOpener {
  constructor(private readonly host: LinkHost) {}

  async open(from: vscode.Uri, href: string): Promise<void> {
    const ref = resolveReference(href, this.host.pathContext(from));
    switch (ref.kind) {
      case 'external':
        await this.host.openExternal(href);
        return;
      case 'fragment':
        this.host.revealFragment(from, ref.fragment);
        return;
      case 'local': {
        // The fragment (a heading) is passed on, the query is dropped.
        const target = this.host.toUri(ref);
        // Outside the workspace folders and the document's folder: ask first, before anything touches the file
        // system (a stat of `\\host\share\x` already makes a network request that can leak credentials).
        if (!ref.inside && !(await this.host.confirm(target))) return;
        await this.openLocal(target, ref.fragment);
        return;
      }
      // Other schemes (command:, vscode:, javascript:...) are ignored on purpose, and so is an empty href.
      case 'unsupported':
      case 'invalid':
        return;
    }
  }

  private async openLocal(target: vscode.Uri, fragment: string): Promise<void> {
    try {
      await this.host.stat(target);
    } catch {
      this.host.warn(`Read Markdown: file not found: ${target.fsPath || target.toString()}`);
      return;
    }
    if (MARKDOWN_EXT.test(target.path)) {
      const preview = await this.host.openPreview(target);
      // `resolveReference` has already percent-decoded the fragment once; decoding it again would corrupt it.
      if (fragment) preview.revealHeading(fragment);
      return;
    }
    await this.host.openFile(target);
  }
}
