import * as assert from 'node:assert/strict';
import { alignBlocks, diffDocument, type SourceBlock } from '../../src/diff/blockDiff';
import { diffSequences, diffWords, similarity, tokenize, tokenizeLines } from '../../src/diff/textDiff';
import { createMarkdownRenderer } from '../../src/render/markdown';

const render = createMarkdownRenderer();
const blocks = (src: string): SourceBlock[] => render(src, { mermaid: true }).topBlocks;

describe('textDiff', () => {
  it('diffs sequences with deletions before insertions in each changed run', () => {
    const edits = diffSequences([...'abcd'], [...'axcy']);
    assert.deepEqual(
      edits?.map((e) => e.op),
      ['eq', 'del', 'ins', 'eq', 'del', 'ins'],
    );
  });

  it('handles empty sides and the size cap', () => {
    assert.deepEqual(diffSequences([], ['x'])?.map((e) => e.op), ['ins']);
    assert.deepEqual(diffSequences(['x'], [])?.map((e) => e.op), ['del']);
    assert.equal(diffSequences([...'abcdef'], [...'uvwxyz'], undefined, 10), undefined);
  });

  it('tokenizes words, whitespace, punctuation and CJK characters', () => {
    assert.deepEqual(tokenize('Hi, wörld  42!'), ['Hi', ',', ' ', 'wörld', '  ', '42', '!']);
    assert.deepEqual(tokenize('日本語ok'), ['日', '本', '語', 'ok']);
    assert.deepEqual(tokenizeLines('a\nb\n\nc'), ['a\n', 'b\n', '\n', 'c']);
  });

  it('diffs words into merged runs', () => {
    assert.deepEqual(diffWords('The quick brown fox', 'The slow brown fox'), [
      { op: 'eq', text: 'The ' },
      { op: 'del', text: 'quick' },
      { op: 'ins', text: 'slow' },
      { op: 'eq', text: ' brown fox' },
    ]);
  });

  it('folds whitespace between changes into one deletion and one insertion', () => {
    assert.deepEqual(diffWords('one two three', 'one four five'), [
      { op: 'eq', text: 'one ' },
      { op: 'del', text: 'two three' },
      { op: 'ins', text: 'four five' },
    ]);
  });

  it('scores similarity on words, ignoring whitespace', () => {
    assert.equal(similarity('a b  c', 'a b c'), 1);
    assert.equal(similarity('', ''), 1);
    assert.ok(similarity('one two three four', 'one two three five') >= 0.75);
    assert.ok(similarity('alpha beta', 'gamma delta') < 0.1);
  });
});

describe('alignBlocks', () => {
  const p = (text: string) => ({ kind: 'p', text });

  it('reports added, removed and modified blocks', () => {
    const ops = alignBlocks(
      [p('intro text here'), p('old paragraph that goes away'), p('the quick brown fox jumps')],
      [p('intro text here'), p('the quick brown cat jumps'), p('brand new block')],
    );
    assert.deepEqual(ops, [
      { op: 'modify', a: 2, b: 1 },
      { op: 'ins', b: 2 },
      { op: 'del', a: 1, before: 1 },
    ]);
  });

  it('only pairs blocks of the same kind', () => {
    const ops = alignBlocks([{ kind: 'h', text: 'Setup steps' }], [{ kind: 'p', text: 'Setup steps' }]);
    assert.deepEqual(ops, [
      { op: 'ins', b: 0 },
      { op: 'del', a: 0, before: 0 },
    ]);
  });

  it('places a removed block after the new version of the modified block before it', () => {
    const ops = alignBlocks([p('first block of text'), p('second block of text goes')], [p('first block of changed text'), p('unrelated words entirely')]);
    assert.deepEqual(ops, [
      { op: 'modify', a: 0, b: 0 },
      { op: 'ins', b: 1 },
      { op: 'del', a: 1, before: 1 },
    ]);
  });

  it('detects moved blocks, exact and edited', () => {
    const moved = 'This paragraph moves to the end of the document.';
    const ops = alignBlocks([p(moved), p('anchor one'), p('anchor two')], [p('anchor one'), p('anchor two'), p(moved)]);
    assert.deepEqual(ops, [
      { op: 'moveTo', a: 0, b: 2, id: 0, edited: false },
      { op: 'moveFrom', a: 0, before: 0, id: 0 },
    ]);

    const edited = alignBlocks(
      [p('Retry policy uses exponential backoff with jitter and caps.'), p('anchor one'), p('anchor two')],
      [p('anchor one'), p('anchor two'), p('Retry policy uses exponential backoff with jitter and limits.')],
      { firstMoveId: 5 },
    );
    assert.deepEqual(edited, [
      { op: 'moveTo', a: 0, b: 2, id: 5, edited: true },
      { op: 'moveFrom', a: 0, before: 0, id: 5 },
    ]);
  });

  it('does not treat short blocks as moved', () => {
    const ops = alignBlocks([{ kind: 'hr', text: '---' }, p('anchor one')], [p('anchor one'), { kind: 'hr', text: '---' }]);
    assert.deepEqual(ops, [
      { op: 'ins', b: 1 },
      { op: 'del', a: 0, before: 0 },
    ]);
  });

  it('uses `key` for identity and `text` for similarity', () => {
    const ops = alignBlocks([{ kind: 'li', text: 'docs', key: '<a href="a">docs</a>' }], [{ kind: 'li', text: 'docs', key: '<a href="b">docs</a>' }]);
    assert.deepEqual(ops, [{ op: 'modify', a: 0, b: 0 }]);
  });
});

describe('diffDocument', () => {
  it('maps block changes to source lines', () => {
    const original = '# Title\n\nKeep this.\n\nRemove this paragraph.\n\nChange one word here.\n';
    const current = '# Title\n\nKeep this.\n\nChange one line here.\n\nAdded at the end.\n';
    assert.deepEqual(diffDocument(blocks(original), blocks(current)), [
      { op: 'modify', oldLine: 6, line: 4 },
      { op: 'ins', line: 6 },
      { op: 'del', oldLine: 4, before: 4 },
    ]);
  });

  it('returns no changes for identical documents', () => {
    const src = '---\ntitle: x\n---\n\n# A\n\n- one\n- two\n';
    assert.deepEqual(diffDocument(blocks(src), blocks(src)), []);
  });
});

describe('renderer topBlocks', () => {
  it('lists top-level blocks with their source text, front matter first', () => {
    const r = render('---\ntitle: x\n---\n\n# A\n\n- one\n- two\n\n```js\nx\n```\n', { mermaid: true });
    assert.deepEqual(
      r.topBlocks.map((b) => [b.kind, b.line, b.end, b.text]),
      [
        ['front_matter', 0, 3, 'title: x'],
        ['heading_open', 4, 5, '# A'],
        ['bullet_list_open', 6, 9, '- one\n- two'],
        ['fence', 9, 12, '```js\nx\n```'],
      ],
    );
  });
});
