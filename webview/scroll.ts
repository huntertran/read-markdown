// Maps between source lines (data-line attributes) and vertical scroll positions.

interface Entry {
  line: number;
  top: number;
}

let entries: Entry[] | undefined;
let root: HTMLElement | undefined;
let suppressUntil = 0;

// Source line that should stay at the top of the viewport. When the content width changes
// (dragging the editor/preview divider, toggling the outline), text reflows and the same scrollY
// would show a different line, so the preview re-scrolls to this line.
let anchorLine = 0;
let holdAnchorUntil = 0;
let lastWidth = -1;

export function initScrollMap(content: HTMLElement): void {
  root = content;
  new ResizeObserver(([entry]) => {
    invalidate();
    const width = entry.contentRect.width;
    const widthChanged = lastWidth >= 0 && Math.abs(width - lastWidth) >= 0.5;
    lastWidth = width;
    if (widthChanged && window.scrollY > 0) scrollToLine(anchorLine);
  }).observe(content);
}

/** Records the line at the top after a scroll, unless the scroll came from scrollToLine. */
export function updateAnchor(): void {
  if (performance.now() >= holdAnchorUntil) anchorLine = lineAtTop();
}

export function invalidate(): void {
  entries = undefined;
}

function getEntries(): Entry[] {
  if (entries) return entries;
  const result: Entry[] = [];
  if (root) {
    const scrollY = window.scrollY;
    let lastLine = -1;
    let lastTop = -Infinity;
    for (const el of root.querySelectorAll<HTMLElement>('[data-line]')) {
      const line = Number(el.dataset.line);
      if (!Number.isFinite(line) || line <= lastLine) continue;
      const rects = el.getClientRects();
      if (rects.length === 0) continue; // hidden (e.g. inside a collapsed section)
      const top = rects[0].top + scrollY;
      if (top < lastTop) continue;
      result.push({ line, top });
      lastLine = line;
      lastTop = top;
    }
  }
  entries = result;
  return result;
}

/** Source line (fractional) at the top of the viewport. */
export function lineAtTop(): number {
  const list = getEntries();
  if (list.length === 0) return 0;
  const y = window.scrollY;
  if (y <= 0) return 0;
  let lo = 0;
  let hi = list.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].top <= y) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const a = list[idx];
  const b = list[idx + 1];
  if (!b || b.top === a.top || y < a.top) return a.line;
  return a.line + ((y - a.top) / (b.top - a.top)) * (b.line - a.line);
}

/** Scrolls so that `line` is at the top of the viewport without echoing the scroll back. */
export function scrollToLine(line: number): void {
  anchorLine = line;
  holdAnchorUntil = performance.now() + 150;
  const list = getEntries();
  if (list.length === 0) return;
  let y: number;
  if (line <= 0) {
    y = 0;
  } else {
    let lo = 0;
    let hi = list.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].line <= line) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const a = list[idx];
    const b = list[idx + 1];
    y = !b || line < a.line ? a.top : a.top + ((line - a.line) / (b.line - a.line)) * (b.top - a.top);
  }
  scrollProgrammatically(y);
}

// Scroll events also fire for programmatic scrolls (editor sync, search reveal) and for scroll
// anchoring when content above the viewport changes height (images, Mermaid). Only scrolls that
// follow real user input are echoed back to the source editor.
const USER_INPUT_WINDOW_MS = 800;
let lastUserInput = -Infinity;
let pointerDown = false;

const markInput = () => (lastUserInput = performance.now());
window.addEventListener('wheel', markInput, { passive: true, capture: true });
window.addEventListener('touchmove', markInput, { passive: true, capture: true });
window.addEventListener('keydown', markInput, { capture: true });
window.addEventListener('pointerdown', () => ((pointerDown = true), markInput()), { capture: true });
window.addEventListener('pointerup', () => ((pointerDown = false), markInput()), { capture: true });
window.addEventListener('blur', () => (pointerDown = false));

export function scrollProgrammatically(y: number): void {
  suppressUntil = performance.now() + 100;
  window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
}

/** True if the current scroll was not caused by the user and must not be echoed to the editor. */
export function isSuppressed(): boolean {
  const now = performance.now();
  if (now < suppressUntil) return true;
  return !pointerDown && now - lastUserInput > USER_INPUT_WINDOW_MS;
}

/** Treat the next scroll as user-initiated (e.g. clicking a heading in the outline). */
export function markUserScroll(): void {
  markInput();
}
