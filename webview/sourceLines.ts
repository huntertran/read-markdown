// Markdown source line numbers in the left gutter (`readMarkdown.preview.lineNumbers`), like the
// editor's: one per top-level block and list item. They live in an overlay in #rm-main (outside
// #rm-content, which every render replaces), are positioned from the blocks' boxes and redrawn
// whenever layout moves. The number is drawn from `data-n` by CSS, so it is not DOM text that the
// find widget or a selection would pick up. Clicking one reveals that line in the source editor.
import { post } from './api';
import { onInvalidate } from './scroll';
import { isFolded } from './sections';

/** Blocks that get a number: the renderer's top-level blocks and every list item. */
const NUMBERED = '[data-line-end], li[data-line]';
/** Closest gap (px) between the middles of two numbers; a closer one is left out instead of overlapping. */
const MIN_GAP = 13;

let content: HTMLElement | undefined;
let main: HTMLElement;
let overlay: HTMLElement;
let enabled = false;
let frame = 0;

export function initSourceLines(contentEl: HTMLElement, mainEl: HTMLElement): void {
  content = contentEl;
  main = mainEl;
  overlay = document.createElement('div');
  overlay.id = 'rm-source-lines';
  main.append(overlay);
  // Sections folding, images loading, the outline resizing: anything that moves blocks.
  const observer = new ResizeObserver(() => scheduleSourceLines());
  observer.observe(content);
  observer.observe(main);
  // Every render (also one patched in place, whose blocks keep their size but not their lines) invalidates.
  onInvalidate(scheduleSourceLines);
  overlay.addEventListener('click', (e) => {
    const label = (e.target as Element).closest<HTMLElement>('.rm-ln');
    if (label) post({ type: 'showSource', line: Number(label.dataset.line) });
  });
}

export function setSourceLines(on: boolean): void {
  enabled = on;
  document.body.classList.toggle('rm-source-lines', on);
  if (!overlay) return;
  if (on) scheduleSourceLines();
  else overlay.replaceChildren();
}

export function scheduleSourceLines(): void {
  if (!enabled || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    updateSourceLines();
  });
}

export function updateSourceLines(): void {
  if (!content || !enabled) return;
  const labels = document.createDocumentFragment();
  const base = main.getBoundingClientRect();
  const left = content.getBoundingClientRect().left - base.left;
  let lastLine = -1;
  let lastMiddle = -Infinity;
  for (const el of content.querySelectorAll<HTMLElement>(NUMBERED)) {
    const line = Number(el.dataset.line);
    // A list starts on the line of its first item: one number for both.
    if (!Number.isInteger(line) || line <= lastLine) continue;
    if (isFolded(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue; // hidden
    // Level with the block's first line of text.
    const style = getComputedStyle(el);
    const fontSize = parseFloat(style.fontSize) || 16;
    const height = parseFloat(style.lineHeight) || fontSize * 1.2;
    const top = r.top - base.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
    const middle = top + height / 2;
    if (middle - lastMiddle < MIN_GAP) continue;
    lastLine = line;
    lastMiddle = middle;
    labels.append(label(line, left, top, height));
  }
  overlay.replaceChildren(labels);
}

function label(line: number, left: number, top: number, height: number): HTMLElement {
  const el = document.createElement('span');
  el.className = 'rm-ln';
  el.dataset.line = String(line);
  el.dataset.n = String(line + 1);
  el.title = `Line ${line + 1}: show in the editor`;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  return el;
}
