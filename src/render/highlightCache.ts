/** Size limits of a {@link LruCache}. */
export interface LruLimits {
  /** Maximum number of entries. */
  maxEntries: number;
  /** Maximum total cost (characters of key + value) over all entries. */
  maxChars: number;
}

/**
 * Least-recently-used map bounded by entry count and total cost. `Map` iterates in insertion order,
 * so re-inserting an entry on every hit keeps the first key the least recently used one.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, { value: V; cost: number }>();
  private totalCost = 0;

  constructor(private readonly limits: LruLimits) {}

  get size(): number {
    return this.entries.size;
  }

  get cost(): number {
    return this.totalCost;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores the entry unless its cost alone exceeds `maxChars` (it would only evict everything else). */
  set(key: string, value: V, cost: number): void {
    this.delete(key);
    if (cost > this.limits.maxChars) return;
    this.entries.set(key, { value, cost });
    this.totalCost += cost;
    while (this.entries.size > this.limits.maxEntries || this.totalCost > this.limits.maxChars) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalCost -= entry.cost;
  }

  clear(): void {
    this.entries.clear();
    this.totalCost = 0;
  }
}

// A render happens on every debounced edit, and the git-baseline document is rendered too, so the
// same code blocks come back again and again. 500 blocks covers a long document and its baseline;
// the character cap (key + value, roughly 2x the block's size; about 8 MB of UTF-16) keeps a few
// huge blocks from pinning memory, and a block above it is simply highlighted every time.
export const DEFAULT_HIGHLIGHT_LIMITS: LruLimits = { maxEntries: 500, maxChars: 4_000_000 };

/** Highlights `code` as `language` and returns HTML. May throw, like highlight.js does. */
export type HighlightFn = (code: string, language: string) => string;

/**
 * Wraps a pure highlighter with an LRU cache. The result may only depend on `language` and `code`
 * (highlight.js options such as `ignoreIllegals` are fixed by the caller). `language` is used as
 * given, not canonicalized, so two aliases of one language are two entries. A call that throws is
 * not cached.
 */
export function createCachedHighlighter(highlight: HighlightFn, limits: LruLimits = DEFAULT_HIGHLIGHT_LIMITS): HighlightFn & { cache: LruCache<string> } {
  const cache = new LruCache<string>(limits);
  const cached = (code: string, language: string): string => {
    // NUL cannot occur in a language name, so the key is unambiguous.
    const key = `${language}\0${code}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const html = highlight(code, language);
    cache.set(key, html, key.length + html.length);
    return html;
  };
  return Object.assign(cached, { cache });
}
