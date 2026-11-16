// Incremental re-render: keeps the live elements of the top-level blocks a render did not change.
//
// A full render replaces the whole `#rm-content`, so every keystroke sanitizes, styles and lays out the
// entire document again. When the new HTML differs from the last one only in a run of blocks that
// contains no heading (so the section tree stays as it is), only those blocks are sanitized and swapped
// in; every other block keeps its element, decorations, Mermaid SVG and section, and only gets its
// source line attributes shifted. Anything else makes the caller fall back to a full render.
//
// Blocks are matched by their render HTML with the line numbers removed (`blockKey`): a common prefix
// and a common suffix are kept, the run in between is replaced.

/** The renderer's source line attributes, which shift when lines are added or removed above a block. */
const LINE_ATTRS = ['data-line', 'data-line-end', 'data-item-end'] as const;
const LINE_ATTR_RE = /\sdata-(?:line|line-end|item-end)="\d+"/g;
const LINE_SELECTOR = LINE_ATTRS.map((a) => `[${a}]`).join(',');
const HEADING = /^H[1-6]$/;

/** The top-level blocks of one render, parsed inertly (never inserted into the document). */
export interface RawBlocks {
  /** Render HTML of each block without its line numbers, in document order. */
  keys: string[];
  /** Tag name of each block (upper case), to check the live DOM still lines up with the keys. */
  tags: string[];
  /** Render HTML of each block, line numbers included. */
  html: string[];
  elements: Element[];
}

/**
 * Splits render HTML into its top-level elements without running or loading anything (a DOMParser
 * document has no browsing context). Undefined if the top level holds anything but elements, comments
 * and whitespace (a stray text node would not survive a block-by-block render).
 */
export function rawBlocks(html: string): RawBlocks | undefined {
  // The explicit <body> keeps a leading <style> in the body, where the full render's sanitizer keeps it.
  const doc = new window.DOMParser().parseFromString(`<body>${html}`, 'text/html');
  const elements: Element[] = [];
  for (const node of doc.body.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE) elements.push(node as Element);
    else if (node.nodeType === Node.TEXT_NODE ? node.textContent?.trim() : node.nodeType !== Node.COMMENT_NODE) return undefined;
  }
  const blockHtml = elements.map((e) => e.outerHTML);
  return {
    keys: blockHtml.map((h) => h.replace(LINE_ATTR_RE, '')),
    tags: elements.map((e) => e.tagName),
    html: blockHtml,
    elements,
  };
}

/**
 * The live elements that came from the top-level blocks of the last render, in document order:
 * children of the content and of section bodies, plus the heading of each section (`sections.ts`).
 */
export function liveBlocks(content: Element): Element[] {
  const out: Element[] = [];
  const walk = (parent: Element) => {
    for (const child of parent.children) {
      if (child.matches('section.rm-section')) {
        for (const part of child.children) {
          if (part.classList.contains('rm-section-body')) walk(part);
          else out.push(part);
        }
      } else out.push(child);
    }
  };
  walk(content);
  return out;
}

function shiftLines(el: Element, delta: number): void {
  for (const node of [el, ...el.querySelectorAll(LINE_SELECTOR)]) {
    for (const attr of LINE_ATTRS) {
      const v = node.getAttribute(attr);
      if (v !== null) node.setAttribute(attr, String(Number(v) + delta));
    }
  }
}

const lineOf = (el: Element) => Number(el.getAttribute('data-line') ?? NaN);
const isHeading = (el: Element) => HEADING.test(el.tagName);

export interface PatchOptions {
  /** Sanitizes the HTML of one block (the full render's sanitizer). */
  sanitize: (html: string) => DocumentFragment;
  /** Decorates new blocks before they are inserted (copy buttons); gets a detached container. */
  decorate: (container: HTMLElement) => void;
}

/**
 * Updates `content` from the blocks `prev` (what it shows) to `next` in place. Returns false, having
 * changed nothing, when that is not safe; the caller then renders in full.
 */
export function patchBlocks(content: HTMLElement, prev: RawBlocks, next: RawBlocks, opts: PatchOptions): boolean {
  const live = liveBlocks(content);
  if (live.length !== prev.keys.length || live.some((el, i) => el.tagName !== prev.tags[i])) return false;

  const n = Math.min(prev.keys.length, next.keys.length);
  let start = 0;
  while (start < n && prev.keys[start] === next.keys[start]) start++;
  let tail = 0;
  while (tail < n - start && prev.keys[prev.keys.length - 1 - tail] === next.keys[next.keys.length - 1 - tail]) tail++;

  const oldRun = live.slice(start, live.length - tail);
  const newRun = next.elements.slice(start, next.elements.length - tail);
  // A heading in either run changes the section tree; raw HTML is left to the full render's parse.
  if ([...oldRun, ...newRun].some((el) => isHeading(el) || el.hasAttribute('data-rm-html'))) return false;
  if (oldRun.some((el) => el.parentNode !== oldRun[0].parentNode)) return false;

  // Sanitize first: one block must stay one element, or the next patch could not line up.
  const fresh: Element[] = [];
  for (const raw of newRun) {
    const frag = opts.sanitize(raw.outerHTML);
    const els = [...frag.childNodes].filter((c) => c.nodeType === Node.ELEMENT_NODE) as Element[];
    const loose = [...frag.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim());
    if (els.length !== 1 || loose || els[0].tagName !== raw.tagName) return false;
    fresh.push(els[0]);
  }

  // Where the new run goes when nothing is replaced: after the previous block, inside its section body
  // if that block is a section's heading; else before the next block; else at the very start.
  let place: ((nodes: Element[]) => void) | undefined;
  if (oldRun.length) {
    const first = oldRun[0];
    place = (nodes) => first.before(...nodes);
  } else {
    const before = live[start - 1];
    const after = live[start];
    if (before && !isHeading(before)) place = (nodes) => before.after(...nodes);
    else if (before) {
      const body = before.parentElement?.matches('section.rm-section') ? before.parentElement.querySelector(':scope > .rm-section-body') : null;
      place = body ? (nodes) => body.prepend(...nodes) : (nodes) => before.after(...nodes);
    } else if (after && !isHeading(after)) place = (nodes) => after.before(...nodes);
    else place = (nodes) => content.prepend(...nodes);
  }

  if (fresh.length) {
    const box = document.createElement('div');
    box.append(...fresh);
    opts.decorate(box);
  }
  place(fresh);
  for (const el of oldRun) el.remove();

  // Kept blocks: same HTML, possibly other lines (lines added or removed above, or blank lines).
  const kept: [Element, Element][] = [
    ...live.slice(0, start).map((el, i): [Element, Element] => [el, next.elements[i]]),
    ...live.slice(live.length - tail).map((el, i): [Element, Element] => [el, next.elements[next.elements.length - tail + i]]),
  ];
  for (const [el, raw] of kept) {
    const delta = lineOf(raw) - lineOf(el);
    if (delta) shiftLines(el, delta);
  }
  return true;
}
