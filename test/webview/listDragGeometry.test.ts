import * as assert from 'node:assert/strict';
import { clampDy, dropPoint, liveTarget, settleOffset, siblingShift, slot, type Slots } from '../../webview/listDragGeometry';

// Four stacked items with no gaps: 100-130, 130-150, 150-170, 170-200 (mids 115, 140, 160, 185).
const A: Slots = { tops: [100, 130, 150, 170], heights: [30, 20, 20, 30] };
// Gaps of 10 between items: 0-20, 30-60, 70-90.
const GAPS: Slots = { tops: [0, 30, 70], heights: [20, 30, 20] };
// An item with a nested list (100 tall) above two single-line items.
const TALL: Slots = { tops: [0, 100, 120], heights: [100, 20, 20] };

/** `liveTarget` the way the drag calls it: with the travel clamped first. */
function live(s: Slots, idx: number, rawDy: number): number {
  return liveTarget(s, idx, clampDy(s, idx, rawDy));
}

describe('list drag geometry', () => {
  describe('slot', () => {
    it('is the distance to the next item top', () => {
      assert.deepEqual([0, 1, 2].map((i) => slot(A, i)), [30, 20, 20]);
      assert.deepEqual([0, 1].map((i) => slot(GAPS, i)), [30, 40]);
    });

    it('is the height plus the gap above for the last item', () => {
      assert.equal(slot(A, 3), 30);
      assert.equal(slot(GAPS, 2), 20 + 10);
      assert.equal(slot(TALL, 2), 20);
    });

    it('is the height for a one-item list', () => {
      assert.equal(slot({ tops: [10], heights: [25] }, 0), 25);
    });
  });

  describe('clampDy', () => {
    it('keeps the travel that stays inside the list', () => {
      assert.equal(clampDy(A, 1, 0), 0);
      assert.equal(clampDy(A, 1, 12), 12);
      assert.equal(clampDy(A, 1, -12), -12);
    });

    it('stops the item at the top and the bottom of the list', () => {
      // Item 1 spans 130-150: up to 100 (-30), down until its bottom meets 200 (+50).
      assert.equal(clampDy(A, 1, -1000), -30);
      assert.equal(clampDy(A, 1, 1000), 50);
      assert.equal(clampDy(A, 1, -30), -30);
      assert.equal(clampDy(A, 1, 50), 50);
    });

    it('allows no travel against the end the item is already at', () => {
      assert.equal(clampDy(A, 0, -40), 0);
      assert.equal(clampDy(A, 3, 40), 0);
    });

    it('counts gaps as part of the list', () => {
      assert.equal(clampDy(GAPS, 0, 1000), 90 - 20);
      assert.equal(clampDy(GAPS, 2, -1000), -70);
    });

    it('a one-item list cannot move', () => {
      assert.equal(clampDy({ tops: [10], heights: [20] }, 0, 300), 0);
    });
  });

  describe('liveTarget (animated drag)', () => {
    it('stays at the origin without travel', () => {
      for (let idx = 0; idx < 4; idx++) assert.equal(live(A, idx, 0), idx);
    });

    it('moves down only once the item middle is strictly past the next middle', () => {
      // Item 1's middle is 140; item 2's is 160.
      assert.equal(live(A, 1, 20), 1);
      assert.equal(live(A, 1, 21), 2);
    });

    it('moves up only once the item middle is strictly above the previous middle', () => {
      // Item 1's middle is 140; item 0's is 115.
      assert.equal(live(A, 1, -25), 1);
      assert.equal(live(A, 1, -26), 0);
    });

    it('passes several items in one move', () => {
      // Item 1 reaches the middle of item 3 (185) at +45.
      assert.equal(live(A, 1, 45), 2);
      assert.equal(live(A, 1, 46), 3);
      // Item 2 (middle 160) reaches the middle of item 0 (115) at -45.
      assert.equal(live(A, 2, -45), 1);
      assert.equal(live(A, 2, -46), 0);
    });

    it('clamps a pointer far beyond the ends to the nearest reachable slot', () => {
      assert.equal(live(A, 1, 10_000), 3);
      assert.equal(live(A, 1, -10_000), 0);
      assert.equal(live(A, 2, 10_000), 3);
      assert.equal(live(A, 2, -10_000), 0);
    });

    it('uses the middles, so items of different heights flip at different distances', () => {
      // Item 1 (20 tall) against its neighbours of 30: it flips with the pointer 21 px away, not 25 or 30.
      assert.equal(live(A, 1, 21), 2);
      assert.equal(live(A, 1, -26), 0);
    });

    it('works with gaps between the items', () => {
      // Middles: 10, 45, 80. Item 0's middle is 10.
      assert.equal(live(GAPS, 0, 35), 0);
      assert.equal(live(GAPS, 0, 36), 1);
      assert.equal(live(GAPS, 2, -35), 2);
      assert.equal(live(GAPS, 2, -36), 1);
    });

    it('lets a tall item (with a nested list) be dragged up past a short one', () => {
      // The tall item is item 0; a short item 2 (middle 130) dragged up passes item 1 (110) at -21.
      assert.equal(live(TALL, 2, -19), 2);
      assert.equal(live(TALL, 2, -21), 1);
      // ... and the tall item's middle (50) at -81.
      assert.equal(live(TALL, 2, -80), 1);
      assert.equal(live(TALL, 2, -81), 0);
    });

    it('a one-item list has no other target', () => {
      assert.equal(live({ tops: [0], heights: [20] }, 0, 100), 0);
    });
  });

  describe('dropPoint (reduced motion)', () => {
    it('puts the line above the first item whose middle is below the pointer', () => {
      const first = dropPoint(A, 1, 100);
      assert.deepEqual(first, { target: 0, lineY: 98 });
      assert.equal(dropPoint(A, 1, 115).target, 0, 'exactly on a middle still belongs above it');
      assert.equal(dropPoint(A, 1, 116).lineY, 128);
    });

    it('is a no-op when the line would sit right above or right below the dragged item', () => {
      // Item 1: the line above it (k = 1) or above the next item (k = 2).
      assert.equal(dropPoint(A, 1, 116).target, 1);
      assert.equal(dropPoint(A, 1, 140).target, 1);
      assert.equal(dropPoint(A, 1, 141).target, 1);
      assert.equal(dropPoint(A, 1, 160).target, 1);
      assert.equal(dropPoint(A, 0, 100).target, 0);
      assert.equal(dropPoint(A, 0, 116).target, 0);
      assert.equal(dropPoint(A, 3, 1000).target, 3);
      assert.equal(dropPoint(A, 3, 186).target, 3);
    });

    it('moves the target down by one less than the line slot (the item itself is removed first)', () => {
      assert.deepEqual(dropPoint(A, 1, 161), { target: 2, lineY: 168 });
      assert.deepEqual(dropPoint(A, 0, 141), { target: 1, lineY: 148 });
    });

    it('moves up to the line slot itself', () => {
      assert.deepEqual(dropPoint(A, 3, 140), { target: 1, lineY: 128 });
      assert.deepEqual(dropPoint(A, 2, 114), { target: 0, lineY: 98 });
    });

    it('reaches the last position with a line below the last item, however far the pointer goes', () => {
      assert.deepEqual(dropPoint(A, 1, 186), { target: 3, lineY: 201 });
      assert.deepEqual(dropPoint(A, 1, 5000), { target: 3, lineY: 201 });
      assert.deepEqual(dropPoint(A, 0, 5000), { target: 3, lineY: 201 });
    });

    it('reaches the first position however far above the list the pointer is', () => {
      assert.deepEqual(dropPoint(A, 3, -5000), { target: 0, lineY: 98 });
      assert.deepEqual(dropPoint(A, 1, -5000), { target: 0, lineY: 98 });
    });

    it('reaches every position of a list with a tall item and with gaps', () => {
      // Dragging the tall item 0 below the two short ones (middles 110, 130).
      assert.equal(dropPoint(TALL, 0, 110).target, 0);
      assert.equal(dropPoint(TALL, 0, 111).target, 1);
      assert.deepEqual(dropPoint(TALL, 0, 131), { target: 2, lineY: 141 });
      assert.deepEqual(dropPoint(TALL, 0, 1000), { target: 2, lineY: 141 });
      // Middles of GAPS: 10, 45, 80.
      assert.deepEqual(dropPoint(GAPS, 2, 44), { target: 1, lineY: 28 });
      assert.deepEqual(dropPoint(GAPS, 0, 81), { target: 2, lineY: 91 });
    });
  });

  describe('siblingShift', () => {
    it('slides the items the dragged one passes going down, up by its slot', () => {
      assert.deepEqual([0, 1, 2, 3].map((i) => siblingShift(1, 3, i, 20)), [0, 0, -20, -20]);
      assert.deepEqual([0, 1, 2, 3].map((i) => siblingShift(0, 1, i, 30)), [0, -30, 0, 0]);
    });

    it('slides the items it passes going up, down by its slot', () => {
      assert.deepEqual([0, 1, 2, 3].map((i) => siblingShift(2, 0, i, 20)), [20, 20, 0, 0]);
    });

    it('moves nothing when the target is the origin', () => {
      assert.deepEqual([0, 1, 2, 3].map((i) => siblingShift(2, 2, i, 20)), [0, 0, 0, 0]);
    });
  });

  describe('settleOffset', () => {
    it('is zero when the item stays', () => {
      assert.equal(settleOffset(A, 1, 1), 0);
    });

    it('goes down by the slots of the items it passes', () => {
      assert.equal(settleOffset(A, 1, 2), 20);
      assert.equal(settleOffset(A, 1, 3), 20 + 30);
      assert.equal(settleOffset(GAPS, 0, 2), 40 + 30);
    });

    it('goes up by the slots of the items it jumps over', () => {
      assert.equal(settleOffset(A, 1, 0), -30);
      assert.equal(settleOffset(A, 3, 0), -(30 + 20 + 20));
      assert.equal(settleOffset(GAPS, 2, 1), -40);
    });

    it('lands the item flush with the slot it moved to', () => {
      // Moving down, the item's bottom ends where the target's bottom was; up, its top where the target's top was.
      assert.equal(A.tops[1] + settleOffset(A, 1, 3) + A.heights[1], A.tops[3] + A.heights[3]);
      assert.equal(A.tops[2] + settleOffset(A, 2, 0), A.tops[0]);
    });
  });
});
