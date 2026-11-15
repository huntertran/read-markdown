// Picks the outline entry for the heading at the top of the viewport from cached heading
// positions, so a scroll frame does no DOM reads. Pure (no DOM) so it can be tested in Node.

export interface HeadingPosition {
  slug: string;
  /** Distance from the top of the document (viewport top + scrollY when it was measured). */
  top: number;
}

export interface HeadingIndex {
  /** Visible headings only, in outline order. */
  entries: HeadingPosition[];
  /** True if `top` never decreases, which makes a binary search equal to the linear scan. */
  sorted: boolean;
}

export function buildHeadingIndex(entries: HeadingPosition[]): HeadingIndex {
  let sorted = true;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].top < entries[i - 1].top) {
      sorted = false;
      break;
    }
  }
  return { entries, sorted };
}

/**
 * The last visible heading whose top is at or above `threshold` (viewport coordinates), stopping
 * at the first visible heading below it; `fallback` while the first heading is still below.
 */
export function findActiveSlug(index: HeadingIndex, scrollY: number, threshold: number, fallback: string): string {
  const { entries } = index;
  const limit = threshold + scrollY;
  if (!index.sorted) {
    // Out-of-order tops (e.g. a floated or transformed heading): keep the first-below-stops rule.
    let slug = fallback;
    for (const e of entries) {
      if (e.top <= limit) slug = e.slug;
      else break;
    }
    return slug;
  }
  let lo = 0;
  let hi = entries.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].top <= limit) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? fallback : entries[found].slug;
}
