import * as assert from 'node:assert/strict';
import { lineInputError, parseLineInput } from '../../src/preview/goToLine';

describe('parseLineInput', () => {
  it('turns a 1-based line into a 0-based one', () => {
    assert.equal(parseLineInput('1', 10), 0);
    assert.equal(parseLineInput('42', 100), 41);
    assert.equal(parseLineInput('  7  ', 10), 6);
  });

  it('accepts a leading colon and ignores a column, like VS Code', () => {
    assert.equal(parseLineInput(':5', 10), 4);
    assert.equal(parseLineInput('5:3', 10), 4);
    assert.equal(parseLineInput('5,3', 10), 4);
    assert.equal(parseLineInput('5:', 10), 4);
  });

  it('clamps to the document', () => {
    assert.equal(parseLineInput('0', 10), 0);
    assert.equal(parseLineInput('500', 10), 9);
    assert.equal(parseLineInput('3', 0), 0);
  });

  it('rejects text that is not a line number', () => {
    for (const text of ['', 'abc', '-3', '1.5', '4 5', '9'.repeat(30)]) assert.equal(parseLineInput(text, 10), undefined, text);
  });
});

describe('lineInputError', () => {
  it('shows no error for an empty box or a line', () => {
    assert.equal(lineInputError('', 10), undefined);
    assert.equal(lineInputError('12', 10), undefined);
  });

  it('names the range otherwise', () => {
    assert.equal(lineInputError('x', 10), 'Type a line number between 1 and 10.');
  });
});
