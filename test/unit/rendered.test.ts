import * as assert from 'node:assert/strict';
import { isRenderedBlock, isRenderedListMove, isRenderedTaskLine, type BlockRange, type ListRange } from '../../src/edit/rendered';
import { createMarkdownRenderer } from '../../src/render/markdown';

const render = createMarkdownRenderer();
const opts = { mermaid: true };

function block(line: number, end: number, kind = 'paragraph_open'): BlockRange {
  return { line, end, kind };
}

describe('isRenderedBlock', () => {
  const blocks = [block(0, 3, 'front_matter'), block(4, 5, 'heading_open'), block(6, 8), block(9, 10, 'html_block')];

  it('accepts exactly a rendered top-level block, front matter included', () => {
    assert.equal(isRenderedBlock(blocks, 0, 3), true);
    assert.equal(isRenderedBlock(blocks, 4, 5), true);
    assert.equal(isRenderedBlock(blocks, 6, 8), true);
  });

  it('rejects off-by-one starts and ends', () => {
    for (const [s, e] of [[1, 3], [0, 2], [0, 4], [5, 5], [4, 6], [3, 5], [6, 7], [7, 8], [6, 9]]) {
      assert.equal(isRenderedBlock(blocks, s, e), false, `${s}-${e}`);
    }
  });

  it('rejects ranges spanning two blocks, inside a block, or outside the document', () => {
    assert.equal(isRenderedBlock(blocks, 4, 8), false);
    assert.equal(isRenderedBlock(blocks, 0, 5), false);
    assert.equal(isRenderedBlock(blocks, 7, 8), false);
    assert.equal(isRenderedBlock(blocks, 100, 101), false);
    assert.equal(isRenderedBlock(blocks, -1, 3), false);
  });

  it('rejects raw HTML blocks, which the preview never edits in place', () => {
    assert.equal(isRenderedBlock(blocks, 9, 10), false);
  });

  it('rejects everything for an empty document and non-integers', () => {
    assert.equal(isRenderedBlock([], 0, 1), false);
    assert.equal(isRenderedBlock(blocks, 4.5, 5), false);
    assert.equal(isRenderedBlock(blocks, '4', 5), false);
    assert.equal(isRenderedBlock(blocks, undefined, undefined), false);
    assert.equal(isRenderedBlock(blocks, NaN, NaN), false);
  });

  it('matches the ranges of a real render', () => {
    const r = render('---\ntitle: x\n---\n# H\n\npara\ncont\n\n- a\n- b\n\n<div>raw</div>\n\n```js\ncode\n```\n', opts);
    assert.equal(isRenderedBlock(r.topBlocks, 0, 3), true); // front matter
    assert.equal(isRenderedBlock(r.topBlocks, 3, 4), true);
    assert.equal(isRenderedBlock(r.topBlocks, 5, 7), true);
    assert.equal(isRenderedBlock(r.topBlocks, 8, 11), true);
    assert.equal(isRenderedBlock(r.topBlocks, 11, 12), false); // raw HTML
    assert.equal(isRenderedBlock(r.topBlocks, 13, 16), true);
    assert.equal(isRenderedBlock(r.topBlocks, 6, 7), false); // inside the paragraph
  });
});

describe('isRenderedTaskLine', () => {
  it('accepts only lines the renderer rendered as task items', () => {
    const src = '- [ ] a\n- [x] b\n- plain [ ] c\n\n```\n- [ ] in code\n```\n\n    - [ ] indented code\n\n<div>\n- [ ] raw\n</div>\n\n> - [/] quoted\n';
    const r = render(src, opts);
    assert.deepEqual(r.taskLines, [0, 1, 14]);
    for (const line of r.taskLines) assert.equal(isRenderedTaskLine(r.taskLines, line), true);
    for (const line of [2, 5, 8, 11, 12, -1, 99]) assert.equal(isRenderedTaskLine(r.taskLines, line), false, String(line));
    assert.equal(isRenderedTaskLine(r.taskLines, 0.5), false);
    assert.equal(isRenderedTaskLine(r.taskLines, '0'), false);
    assert.equal(isRenderedTaskLine([], 0), false);
  });
});

describe('isRenderedListMove', () => {
  const lists: ListRange[] = [
    { starts: [0, 1, 3], end: 5 },
    { starts: [10, 11], end: 12 },
  ];

  it('accepts all siblings of one list with the end of the last', () => {
    assert.equal(isRenderedListMove(lists, [0, 1, 3], 5), true);
    assert.equal(isRenderedListMove(lists, [10, 11], 12), true);
  });

  it('rejects items of two lists, a wrong end, an incomplete or reordered set', () => {
    assert.equal(isRenderedListMove(lists, [0, 1, 3, 10, 11], 12), false);
    assert.equal(isRenderedListMove(lists, [1, 10], 12), false);
    assert.equal(isRenderedListMove(lists, [0, 1, 3], 4), false);
    assert.equal(isRenderedListMove(lists, [0, 1, 3], 6), false);
    assert.equal(isRenderedListMove(lists, [0, 1], 5), false);
    assert.equal(isRenderedListMove(lists, [1, 3], 5), false);
    assert.equal(isRenderedListMove(lists, [0, 3, 1], 5), false);
    assert.equal(isRenderedListMove(lists, [0], 1), false);
    assert.equal(isRenderedListMove(lists, [], 0), false);
    assert.equal(isRenderedListMove(lists, 'x', 5), false);
    assert.equal(isRenderedListMove(lists, [0, 1, 3], '5'), false);
    assert.equal(isRenderedListMove([], [0, 1], 2), false);
  });

  it('distinguishes a nested list from its parent', () => {
    const r = render('- a\n  - a1\n  - a2\n- b\n- c\n', opts);
    assert.equal(isRenderedListMove(r.lists, [0, 3, 4], 5), true); // parent items
    assert.equal(isRenderedListMove(r.lists, [1, 2], 3), true); // nested items
    assert.equal(isRenderedListMove(r.lists, [0, 1, 2, 3, 4], 5), false); // parent mixed with nested
    assert.equal(isRenderedListMove(r.lists, [0, 1, 3], 5), false);
    assert.equal(isRenderedListMove(r.lists, [0, 3], 5), false); // incomplete
    assert.equal(isRenderedListMove(r.lists, [1, 2], 5), false); // the parent's end
  });
});
