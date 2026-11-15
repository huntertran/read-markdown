import * as assert from 'node:assert/strict';
import { buildHeadingIndex, findActiveSlug, type HeadingPosition } from '../../webview/activeHeading';

/** The linear scan `nav.updateActive` used before the cache: first visible heading below the threshold stops it. */
function reference(entries: HeadingPosition[], scrollY: number, threshold: number, fallback: string): string {
  let slug = fallback;
  for (const e of entries) {
    if (e.top - scrollY <= threshold) slug = e.slug;
    else break;
  }
  return slug;
}

/** Small deterministic generator (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (...tops: number[]): HeadingPosition[] => tops.map((top, i) => ({ slug: `h${i}`, top }));

describe('active heading lookup', () => {
  it('falls back to the first heading when there are no visible headings', () => {
    assert.equal(findActiveSlug(buildHeadingIndex([]), 500, 120, 'first'), 'first');
  });

  it('falls back while scrolled above the first heading', () => {
    const index = buildHeadingIndex(at(300, 900));
    assert.equal(findActiveSlug(index, 0, 120, 'first'), 'first');
  });

  it('uses the threshold inclusively, in viewport coordinates', () => {
    const index = buildHeadingIndex(at(100, 600, 1200));
    // Heading 1 sits at viewport y = 600 - 480 = 120, exactly on the threshold.
    assert.equal(findActiveSlug(index, 480, 120, 'x'), 'h1');
    assert.equal(findActiveSlug(index, 479, 120, 'x'), 'h0');
  });

  it('picks the last heading at the bottom of the document', () => {
    const index = buildHeadingIndex(at(0, 400, 800));
    assert.equal(findActiveSlug(index, 5000, 120, 'x'), 'h2');
  });

  it('flags out-of-order positions and still matches the first-below-stops rule', () => {
    const entries = at(0, 900, 300, 1200); // h2 is above h1: the scan stops at h1
    const index = buildHeadingIndex(entries);
    assert.equal(index.sorted, false);
    for (const y of [0, 100, 250, 700, 800, 1500]) {
      assert.equal(findActiveSlug(index, y, 120, 'f'), reference(entries, y, 120, 'f'), `scrollY ${y}`);
    }
  });

  it('equals the linear scan on random sorted and unsorted documents', () => {
    const rand = rng(7);
    for (let round = 0; round < 300; round++) {
      const n = Math.floor(rand() * 40);
      const tops: number[] = [];
      let y = rand() * 200;
      for (let i = 0; i < n; i++) {
        // Duplicate tops (empty sections) happen too; every few rounds one heading is out of order.
        y += Math.floor(rand() * 3) === 0 ? 0 : rand() * 500;
        tops.push(round % 4 === 0 && i === 3 ? y - 600 : y);
      }
      const entries = at(...tops);
      const index = buildHeadingIndex(entries);
      const threshold = rand() * 200;
      for (let k = 0; k < 20; k++) {
        const scrollY = rand() * (y + 800) - 100;
        assert.equal(findActiveSlug(index, scrollY, threshold, 'f'), reference(entries, scrollY, threshold, 'f'), `round ${round} scrollY ${scrollY}`);
      }
    }
  });
});
