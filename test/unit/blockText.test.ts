import * as assert from 'node:assert/strict';
import { isValidBlockRange, taskMarkerColumn, toEditText, toReplacement } from '../../src/edit/blockText';

describe('isValidBlockRange', () => {
  it('accepts non-empty whole-line ranges inside the document', () => {
    assert.equal(isValidBlockRange(0, 1, 1), true);
    assert.equal(isValidBlockRange(2, 5, 5), true);
  });

  it('rejects empty, reversed, out-of-bounds and non-integer ranges', () => {
    assert.equal(isValidBlockRange(1, 1, 5), false);
    assert.equal(isValidBlockRange(3, 2, 5), false);
    assert.equal(isValidBlockRange(-1, 2, 5), false);
    assert.equal(isValidBlockRange(0, 6, 5), false);
    assert.equal(isValidBlockRange(0.5, 2, 5), false);
    assert.equal(isValidBlockRange('0', 2, 5), false);
    assert.equal(isValidBlockRange(0, NaN, 5), false);
  });
});

describe('toEditText', () => {
  it('normalizes line endings and drops trailing line breaks', () => {
    assert.equal(toEditText('a\r\nb\r\n'), 'a\nb');
    assert.equal(toEditText('- a\n- b\n\n'), '- a\n- b');
    assert.equal(toEditText('last line'), 'last line');
  });

  it('keeps trailing spaces (hard breaks, code)', () => {
    assert.equal(toEditText('a  \nb  \n'), 'a  \nb  ');
  });
});

describe('toReplacement', () => {
  it('round-trips unchanged text exactly', () => {
    for (const original of ['para\n', '- a\n- b\n\n', 'a\r\nb\r\n', 'no newline', '```\ncode\n```\n']) {
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      assert.equal(toReplacement(original, toEditText(original), eol), original);
    }
  });

  it("re-appends the original's trailing line breaks", () => {
    assert.equal(toReplacement('- a\n\n', '- a\n- b', '\n'), '- a\n- b\n\n');
    assert.equal(toReplacement('para\n', 'new para\n\n\n', '\n'), 'new para\n');
    assert.equal(toReplacement('end of file', 'still the end', '\n'), 'still the end');
  });

  it("converts line endings to the document's EOL", () => {
    assert.equal(toReplacement('a\r\n', 'x\ny', '\r\n'), 'x\r\ny\r\n');
    assert.equal(toReplacement('a\n', 'x\r\ny', '\n'), 'x\ny\n');
  });

  it('deletes the block when the edit is empty', () => {
    assert.equal(toReplacement('para\n\n', '', '\n'), '');
    assert.equal(toReplacement('para\n', '\n\n', '\n'), '');
  });
});

describe('taskMarkerColumn', () => {
  it('finds the state character of task list items', () => {
    assert.equal(taskMarkerColumn('- [ ] todo'), 3);
    assert.equal(taskMarkerColumn('* [x] done'), 3);
    assert.equal(taskMarkerColumn('  + [X] nested'), 5);
    assert.equal(taskMarkerColumn('12. [ ] numbered'), 5);
    assert.equal(taskMarkerColumn('1) [x] paren'), 4);
    assert.equal(taskMarkerColumn('> - [ ] quoted'), 5);
    assert.equal(taskMarkerColumn('> > 1. [x] deep'), 8);
  });

  it('finds in-progress markers', () => {
    assert.equal(taskMarkerColumn('- [/] working'), 3);
    assert.equal(taskMarkerColumn('  * [~] nested'), 5);
    assert.equal(taskMarkerColumn('3. [-] numbered'), 4);
  });

  it('ignores lines that are not task items', () => {
    assert.equal(taskMarkerColumn('[ ] no list marker'), undefined);
    assert.equal(taskMarkerColumn('- [y] not a state'), undefined);
    assert.equal(taskMarkerColumn('-[ ] no space'), undefined);
    assert.equal(taskMarkerColumn('- plain item'), undefined);
  });
});
