// Highlights occurrences of the text selected in the source editor using the CSS Custom Highlight API
// (no DOM mutation, so it is cheap and does not disturb scroll sync or selection).
import { expandTo } from './sections';
import { invalidate, scrollProgrammatically } from './scroll';
import { createIndexCache, findMatches, type IndexCache } from './searchIndex';

export interface SearchRequest {
  term: string;
  caseSensitive: boolean;
  blockLine: number;
  occurrence: number;
}

let current: SearchRequest | undefined;
let badge: HTMLElement | undefined;

const supported = typeof CSS !== 'undefined' && 'highlights' in CSS;

export function initSearch(badgeEl: HTMLElement): void {
  badge = badgeEl;
}

export function setSearch(root: HTMLElement, req: SearchRequest): void {
  current = req.term ? req : undefined;
  apply(root, true);
}

/** Re-applies the active search after the content was re-rendered. */
export function reapplySearch(root: HTMLElement): void {
  // The observer would catch the new content too; dropping the index here makes it explicit.
  cache?.index.invalidate();
  apply(root, false);
}

// The flattened text is reused between selection changes; see createIndexCache for what invalidates it.
let cache: { root: HTMLElement; index: IndexCache } | undefined;

function indexFor(root: HTMLElement): IndexCache {
  if (cache?.root !== root) {
    cache?.index.dispose();
    cache = { root, index: createIndexCache(root) };
  }
  return cache.index;
}

function dropIndex(): void {
  cache?.index.dispose();
  cache = undefined;
}

function apply(root: HTMLElement, reveal: boolean): void {
  if (!supported) return;
  CSS.highlights.delete('rm-search');
  CSS.highlights.delete('rm-search-current');
  if (!current) {
    // No search: stop observing the preview.
    dropIndex();
    if (badge) badge.hidden = true;
    return;
  }

  const ranges = findMatches(indexFor(root).get(), current.term, current.caseSensitive);

  if (ranges.length === 0) {
    showBadge(current.term, 0, 0);
    return;
  }

  const currentIndex = pickCurrent(root, ranges, current);
  const others = ranges.filter((_, i) => i !== currentIndex);
  CSS.highlights.set('rm-search', new Highlight(...others));
  CSS.highlights.set('rm-search-current', new Highlight(ranges[currentIndex]));
  showBadge(current.term, currentIndex + 1, ranges.length);

  if (reveal) {
    const range = ranges[currentIndex];
    if (expandTo(range.startContainer)) invalidate();
    const rect = range.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      scrollProgrammatically(window.scrollY + rect.top - window.innerHeight / 3);
    }
  }
}

function lineOf(node: Node): number {
  const el = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-line]');
  return el ? Number(el.dataset.line) : 0;
}

function pickCurrent(root: HTMLElement, ranges: Range[], req: SearchRequest): number {
  // Outermost element starting at the source block that contains the selection.
  const block = root.querySelector(`[data-line="${req.blockLine}"]`);
  if (block) {
    const inBlock: number[] = [];
    ranges.forEach((r, i) => {
      if (block.contains(r.startContainer)) inBlock.push(i);
    });
    if (inBlock.length) return inBlock[Math.min(req.occurrence, inBlock.length - 1)];
  }
  // Fallback: the match whose block is closest to the selection line.
  let best = 0;
  let bestDistance = Infinity;
  ranges.forEach((r, i) => {
    const d = Math.abs(lineOf(r.startContainer) - req.blockLine);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  });
  return best;
}

function showBadge(term: string, index: number, total: number): void {
  if (!badge) return;
  badge.hidden = false;
  const shown = term.length > 30 ? `${term.slice(0, 30)}…` : term;
  badge.textContent = total ? `“${shown}” ${index}/${total}` : `“${shown}” no matches`;
  badge.classList.toggle('rm-no-match', total === 0);
}
