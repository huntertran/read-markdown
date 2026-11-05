import * as assert from 'node:assert/strict';
import { blockStartFor, countOccurrences, searchTermFromSelection } from '../../src/sync/selection';

describe('searchTermFromSelection', () => {
  it('ignores empty, multi-line and too short selections', () => {
    assert.equal(searchTermFromSelection('', 2), undefined);
    assert.equal(searchTermFromSelection('a\nb', 2), undefined);
    assert.equal(searchTermFromSelection('a', 2), undefined);
    assert.equal(searchTermFromSelection('   ', 1), undefined);
  });

  it('returns plain selections unchanged', () => {
    assert.deepEqual(searchTermFromSelection('config file', 2), { term: 'config file', offset: 0 });
  });

  it('strips markdown wrappers and line prefixes', () => {
    assert.deepEqual(searchTermFromSelection('**bold text**', 2), { term: 'bold text', offset: 2 });
    assert.deepEqual(searchTermFromSelection('`code`', 2), { term: 'code', offset: 1 });
    assert.deepEqual(searchTermFromSelection('## Heading', 2), { term: 'Heading', offset: 3 });
    assert.deepEqual(searchTermFromSelection('- [ ] task', 2), { term: 'task', offset: 6 });
  });

  it('does not strip unbalanced markers', () => {
    assert.deepEqual(searchTermFromSelection('_private', 2), { term: '_private', offset: 0 });
  });
});

describe('countOccurrences', () => {
  it('counts non-overlapping matches with optional case folding', () => {
    assert.equal(countOccurrences('Foo foo FOO', 'foo', false), 3);
    assert.equal(countOccurrences('Foo foo FOO', 'foo', true), 1);
    assert.equal(countOccurrences('aaaa', 'aa', true), 2);
    assert.equal(countOccurrences('abc', '', true), 0);
  });
});

describe('blockStartFor', () => {
  it('finds the closest block start at or before a line', () => {
    const lines = [0, 2, 5, 9];
    assert.equal(blockStartFor(lines, 0), 0);
    assert.equal(blockStartFor(lines, 4), 2);
    assert.equal(blockStartFor(lines, 9), 9);
    assert.equal(blockStartFor(lines, 100), 9);
    assert.equal(blockStartFor([], 3), 0);
  });
});
