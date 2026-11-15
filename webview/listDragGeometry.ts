// The pure geometry of list item dragging (see listDrag.ts), kept free of the DOM so it can be unit
// tested. Everything works on the item slots measured when the drag started: `tops` are page-relative
// tops and `heights` the item heights, both in list order. `idx` is the dragged item's index.

export interface Slots {
  tops: readonly number[];
  heights: readonly number[];
}

/** Distance from item `i`'s top to the next item's top (the last one uses the gap above it). */
export function slot(s: Slots, i: number): number {
  const n = s.tops.length;
  if (i + 1 < n) return s.tops[i + 1] - s.tops[i];
  const gap = n > 1 ? s.tops[i] - (s.tops[i - 1] + s.heights[i - 1]) : 0;
  return s.heights[i] + gap;
}

/** The pointer's vertical travel since the drag started, clamped so the item stays inside the list. */
export function clampDy(s: Slots, idx: number, rawDy: number): number {
  const n = s.tops.length;
  const minDy = s.tops[0] - s.tops[idx];
  const maxDy = s.tops[n - 1] + s.heights[n - 1] - (s.tops[idx] + s.heights[idx]);
  return Math.max(minDy, Math.min(maxDy, rawDy));
}

/**
 * Live reorder (animated drag): the dragged item's middle passing a sibling's middle moves the target
 * to that sibling's index. `dy` is the clamped travel (see `clampDy`). Returns the target index.
 */
export function liveTarget(s: Slots, idx: number, dy: number): number {
  const n = s.tops.length;
  const mid = (i: number) => s.tops[i] + s.heights[i] / 2;
  const center = mid(idx) + dy;
  let t = idx;
  for (let i = idx + 1; i < n; i++) if (center > mid(i)) t = i;
  if (t === idx) for (let i = idx - 1; i >= 0; i--) if (center < mid(i)) t = i;
  return t;
}

export interface DropPoint {
  /** The index the dragged item ends up at (equal to `idx` for no move). */
  target: number;
  /** Page y of the drop line: just above the first item whose middle is below the pointer, or below the last. */
  lineY: number;
}

/** Reduced motion: the line goes before the first item whose middle is below the pointer. */
export function dropPoint(s: Slots, idx: number, pageY: number): DropPoint {
  const n = s.tops.length;
  let k = 0;
  while (k < n && pageY > s.tops[k] + s.heights[k] / 2) k++;
  return {
    target: k > idx ? k - 1 : k,
    lineY: k < n ? s.tops[k] - 2 : s.tops[n - 1] + s.heights[n - 1] + 1,
  };
}

/**
 * How far sibling `i` slides while the dragged item (`idx`) is on its way to `target`: up by the
 * dragged item's slot for the siblings it passes going down, down by it for those it passes going up.
 */
export function siblingShift(idx: number, target: number, i: number, shift: number): number {
  if (target > idx && i > idx && i <= target) return -shift;
  if (target < idx && i >= target && i < idx) return shift;
  return 0;
}

/** How far the dragged item travels from its own slot to the slot of index `to`. */
export function settleOffset(s: Slots, idx: number, to: number): number {
  let offset = 0;
  if (to > idx) for (let i = idx + 1; i <= to; i++) offset += slot(s, i);
  else if (to < idx) for (let i = to; i < idx; i++) offset -= slot(s, i);
  return offset;
}
