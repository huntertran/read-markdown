// Flattened text of the preview and the matching of a search term in it. The index is expensive
// (one `closest()` per text node), so it is cached until the DOM changes in a way that could alter it.
import { REMOVED_SELECTOR } from './changes';

export const MAX_MATCHES = 5000;
// Removed text (track changes) is not in the source, so it must not shift occurrence counts.
const SKIP = `.rm-mermaid, .rm-fold, .rm-copy, button, style, script, svg, del.rm-del, ${REMOVED_SELECTOR}`;
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dt, dd, summary, figcaption, div, section, table';
/** Class names that appear in SKIP: adding or removing one changes which text nodes are walked. */
const SKIP_CLASSES = ['rm-mermaid', 'rm-fold', 'rm-copy', 'rm-del', 'rm-chg-del', 'rm-chg-move-from'];

export interface TextIndex {
  /** All searchable text; a NUL separates blocks so matches cannot cross them. */
  text: string;
  nodes: Text[];
  /** Offset of each node's first character in `text`. */
  starts: number[];
}

/** Flattens the text nodes under `root`, inserting a separator between blocks. */
export function buildTextIndex(root: HTMLElement): TextIndex {
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
  return { text, nodes, starts };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One Range per occurrence of `term` (whitespace-flexible), in document order. */
export function findMatches(index: TextIndex, term: string, caseSensitive: boolean): Range[] {
  const { text, nodes, starts } = index;
  const pattern = escapeRegExp(term).replace(/\s+/g, '\\s+');
  const re = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
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
  return ranges;
}

/** True if a `class` change from `oldValue` to the element's current value alters SKIP matching. */
export function skipClassesChanged(oldValue: string | null, el: Element): boolean {
  const before = new Set((oldValue ?? '').split(/\s+/));
  const now = el.classList;
  return SKIP_CLASSES.some((c) => before.has(c) !== now.contains(c));
}

export interface IndexCache {
  get(): TextIndex;
  invalidate(): void;
  dispose(): void;
}

/**
 * Caches `buildTextIndex(root)`. A MutationObserver watches everything the index depends on: nodes
 * added or removed, text edited, and class changes that move an element into or out of SKIP. Its
 * pending records are read synchronously in `get()`, because the observer callback would only run
 * after the DOM change that precedes a lookup in the same task (e.g. render, then reapply). Style
 * and highlight changes, which do not touch the walk, leave the cache alone. The CSS highlights
 * themselves never modify the DOM, so a highlight/clear cycle cannot stale the index.
 */
export function createIndexCache(root: HTMLElement): IndexCache {
  let index: TextIndex | undefined;
  const process = (records: MutationRecord[]): void => {
    for (const r of records) {
      if (r.type !== 'attributes' || skipClassesChanged(r.oldValue, r.target as Element)) index = undefined;
    }
  };
  const observer = new MutationObserver(process);
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true,
  });
  return {
    get() {
      process(observer.takeRecords());
      index ??= buildTextIndex(root);
      return index;
    },
    invalidate() {
      observer.takeRecords();
      index = undefined;
    },
    dispose() {
      observer.disconnect();
      index = undefined;
    },
  };
}
