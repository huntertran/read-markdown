import * as assert from 'node:assert/strict';
import { moveListItem } from '../../src/edit/listMove';

/**
 * Moves an item in `source` (starting with the first item) and returns the whole new text. Like
 * the extension, it passes only the lines up to the list's end line `end` (default: all).
 */
function move(source: string, starts: number[], from: number, to: number, end?: number): { text: string; movedOffset: number } | undefined {
  const lines = source.split('\n');
  const r = moveListItem(lines.slice(0, end ?? lines.length), starts, from, to);
  if (!r) return undefined;
  return { text: [...r.lines, ...lines.slice(r.count)].join('\n'), movedOffset: r.movedOffset };
}

describe('moveListItem', () => {
  it('moves an item down and up in a tight list', () => {
    assert.equal(move('- a\n- b\n- c', [0, 1, 2], 0, 2)?.text, '- b\n- c\n- a');
    assert.equal(move('- a\n- b\n- c', [0, 1, 2], 2, 0)?.text, '- c\n- a\n- b');
  });

  it('reports where the moved item starts', () => {
    assert.equal(move('- a\n- b\n  more\n- c', [0, 1, 3], 0, 2)?.movedOffset, 3);
    assert.equal(move('- a\n- b\n  more\n- c', [0, 1, 3], 1, 0)?.movedOffset, 0);
  });

  it('carries continuation lines and nested items with the item', () => {
    const src = '- a\n- b\n  more\n  - b1\n  - b2\n- c';
    assert.equal(move(src, [0, 1, 5], 1, 2)?.text, '- a\n- c\n- b\n  more\n  - b1\n  - b2');
  });

  it('keeps blank-line separators in place in a loose list', () => {
    // The last item's trailing blank line belongs to the list's surroundings and stays put.
    const src = '- a\n\n- b\n\n- c\n\nafter';
    // markdown-it ends this list at line 6, after the blank line that follows "- c".
    assert.equal(move(src, [0, 2, 4], 2, 0, 6)?.text, '- c\n\n- a\n\n- b\n\nafter');
    assert.equal(move(src, [0, 2, 4], 0, 2, 6)?.text, '- b\n\n- c\n\n- a\n\nafter');
  });

  it('keeps task markers and their state', () => {
    assert.equal(move('- [x] done\n- [ ] todo', [0, 1], 1, 0)?.text, '- [ ] todo\n- [x] done');
  });

  it('renumbers ordered lists by position', () => {
    assert.equal(move('1. x\n2. y\n3. z', [0, 1, 2], 2, 0)?.text, '1. z\n2. x\n3. y');
    assert.equal(move('1) x\n1) y\n1) z', [0, 1, 2], 0, 2)?.text, '1) y\n1) z\n1) x');
    assert.equal(move('   4. x\n   5. y', [0, 1], 0, 1)?.text, '   4. y\n   5. x');
  });

  it('moves indented (nested) siblings', () => {
    assert.equal(move('  - n1\n  - n2', [0, 1], 0, 1)?.text, '  - n2\n  - n1');
  });

  it('rejects input that is not one list of sibling items', () => {
    const lines = ['- a', '- b', '- c'];
    assert.equal(moveListItem(lines, [0, 1, 2], 1, 1), undefined, 'no-op move');
    assert.equal(moveListItem(lines, [0, 1, 2], 0, 3), undefined, 'target out of range');
    assert.equal(moveListItem(lines, [0, 2, 1], 0, 1), undefined, 'starts not increasing');
    assert.equal(moveListItem(lines, [1, 2], 0, 1), undefined, 'first start not 0');
    assert.equal(moveListItem(lines, [0, 1, 5], 0, 1), undefined, 'start past the end');
    assert.equal(moveListItem(lines, [0], 0, 0), undefined, 'single item');
    assert.equal(moveListItem(['- a', 'text'], [0, 1], 0, 1), undefined, 'not an item');
    assert.equal(moveListItem(['- a', '  - b'], [0, 1], 0, 1), undefined, 'different indent');
    assert.equal(moveListItem(['- a', '1. b'], [0, 1], 0, 1), undefined, 'mixed bullets and numbers');
    assert.equal(moveListItem(['> - a', '> - b'], [0, 1], 0, 1), undefined, 'inside a blockquote');
  });
});
