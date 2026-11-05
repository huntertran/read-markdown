// Highlights occurrences of the text selected in the source editor using the CSS Custom Highlight API
// (no DOM mutation, so it is cheap and does not disturb scroll sync or selection).
import { expandTo } from './sections';
import { invalidate, scrollProgrammatically } from './scroll';

export interface SearchRequest {
  term: string;
  caseSensitive: boolean;
  blockLine: number;
  occurrence: number;
}

const MAX_MATCHES = 5000;
const SKIP = '.rm-mermaid, .rm-fold, .rm-copy, button, style, script, svg';
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dt, dd, summary, figcaption, div, section, table';

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
  apply(root, false);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function apply(root: HTMLElement, reveal: boolean): void {
  if (!supported) return;
  CSS.highlights.delete('rm-search');
  CSS.highlights.delete('rm-search-current');
  if (!current) {
    if (badge) badge.hidden = true;
    return;
  }

  // Flatten text nodes, inserting a separator between blocks so matches never span blocks.
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const block = n.parentElement?.closest(BLOCK) ?? null;
    if (block !== lastBlock) {
      text += '\u0000'; // not matched by \s, so matches cannot cross blocks
      lastBlock = block;
    }
    nodes.push(n);
    starts.push(text.length);
    text += n.data;
  }

  const pattern = escapeRegExp(current.term).replace(/\s+/g, '\\s+');
  const re = new RegExp(pattern, current.caseSensitive ? 'g' : 'gi');
  const ranges: Range[] = [];
  const locate = (offset: number, isEnd: boolean): [Text, number] => {
    let lo = 0;
    let hi = starts.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      // For an end offset prefer the node in which the match ends (offset may equal its length).
      if (starts[mid] < offset || (!isEnd && starts[mid] === offset)) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return [nodes[idx], Math.min(offset - starts[idx], nodes[idx].length)];
  };
  for (let m = re.exec(text); m && ranges.length < MAX_MATCHES; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const range = document.createRange();
    const [sn, so] = locate(m.index, false);
    const [en, eo] = locate(m.index + m[0].length, true);
    range.setStart(sn, so);
    range.setEnd(en, eo);
    ranges.push(range);
  }

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
