// The webview's copy of the original (git index) version the extension renders for track changes.
// The extension sends `originalHtml` only when the baseline is new (`DocChanges.baselineId`); later
// renders cite just the id. At most one baseline is kept, sanitized once and shared by every render
// against it (`applyChanges` only reads it).
import type { ToWebview } from '../src/protocol';
import { type Baseline, indexBaseline } from './changes';

type RenderMessage = Extract<ToWebview, { type: 'render' }>;

interface Entry {
  id: number;
  /** Raw HTML until first use (a render held back for an open editor may be superseded before it is applied). */
  html?: string;
  blocks?: Baseline;
}

let entry: Entry | undefined;
/** Id the extension was already asked for; one request per id, so a missing baseline can never loop. */
let requested: number | undefined;

/**
 * Call for every `render` message as it ARRIVES, even if it is held back: a later render may cite the same id
 * without the HTML. Stores the baseline the message carries, releases it when the message has no changes (the
 * extension forgets it then too), and returns the message without the HTML so nothing else keeps a second copy.
 */
export function acceptRender(msg: RenderMessage): RenderMessage {
  const changes = msg.changes;
  if (!changes) {
    entry = undefined;
    requested = undefined;
    return msg;
  }
  if (changes.originalHtml === undefined) return msg;
  if (entry?.id !== changes.baselineId) entry = { id: changes.baselineId, html: changes.originalHtml };
  if (requested === changes.baselineId) requested = undefined;
  return { ...msg, changes: { baselineId: changes.baselineId, ops: changes.ops } };
}

/** The sanitized blocks of baseline `id`, or undefined if the webview does not have it. */
export function baselineFor(id: number): Baseline | undefined {
  if (entry?.id !== id) return undefined;
  if (!entry.blocks) {
    entry.blocks = indexBaseline(entry.html ?? '');
    entry.html = undefined;
  }
  return entry.blocks;
}

/** True the first time baseline `id` is found missing: the caller then asks the extension for it. */
export function shouldRequestBaseline(id: number): boolean {
  if (requested === id) return false;
  requested = id;
  return true;
}

/** Drops everything (tests). */
export function resetBaseline(): void {
  entry = undefined;
  requested = undefined;
}
