import * as assert from 'node:assert/strict';
import { alignBlocks, diffDocument, type SourceBlock } from '../../src/diff/blockDiff';
import { bagSimilarity, diffSequences, diffWords, similarity, tokenBag, tokenize, tokenizeLines } from '../../src/diff/textDiff';
import { createMarkdownRenderer } from '../../src/render/markdown';

const render = createMarkdownRenderer();
const blocks = (src: string): SourceBlock[] => render(src, { mermaid: true }).topBlocks;

/** Small deterministic generator, so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** The implementation `similarity` replaced: full edit script, count the `eq` edits. */
function referenceSimilarity(a: string, b: string): number {
  const ta = tokenize(a).filter((t) => /\S/.test(t));
  const tb = tokenize(b).filter((t) => /\S/.test(t));
  if (ta.length === 0 && tb.length === 0) return 1;
  const edits = diffSequences(ta, tb, undefined, 1_000_000);
  if (!edits) return 0;
  return (2 * edits.filter((e) => e.op === 'eq').length) / (ta.length + tb.length);
}

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

  it('computes the same similarity as the full edit script', () => {
    const fixed: [string, string][] = [
      ['', ''],
      ['', 'a b'],
      ['a b', ''],
      ['a b c', 'a b c'],
      ['a b c d e', 'x b c d y'],
      ['a b c', 'c b a'],
      ['a a a a', 'a a'],
      ['one two three', 'zero one two three four'],
      ['x', 'y'],
    ];
    for (const [a, b] of fixed) assert.equal(similarity(a, b), referenceSimilarity(a, b), JSON.stringify([a, b]));

    const rand = rng(7);
    const words = (n: number, vocab: number) => Array.from({ length: n }, () => `w${Math.floor(rand() * vocab)}`).join(' ');
    for (let i = 0; i < 300; i++) {
      const vocab = 2 + Math.floor(rand() * 12);
      const a = words(Math.floor(rand() * 40), vocab);
      // Half of the pairs are edits of `a` (shared prefix/suffix), half unrelated.
      const b = i % 2 ? words(Math.floor(rand() * 40), vocab) : `${a.slice(0, a.length >> 1)} ${words(5, vocab)} ${a.slice(a.length >> 1)}`;
      assert.equal(similarity(a, b), referenceSimilarity(a, b), JSON.stringify([a, b]));
      // The word-bag score is an upper bound, which is what lets move detection skip pairs early.
      assert.ok(bagSimilarity(tokenBag(a), tokenBag(b)) >= similarity(a, b), JSON.stringify([a, b]));
    }
  });

  it('keeps the size cap: a too large changed middle scores 0', () => {
    const a = Array.from({ length: 1100 }, (_, i) => `a${i}`).join(' ');
    const b = Array.from({ length: 1100 }, (_, i) => `b${i}`).join(' ');
    assert.equal(similarity(a, b), 0);
    assert.equal(referenceSimilarity(a, b), 0);
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

  it('shows everything that is not identical as removed + added once the budget is spent', () => {
    const original = '# Title\n\nKeep this.\n\nRemove this paragraph.\n\nChange one word here.\n';
    const current = '# Title\n\nKeep this.\n\nChange one line here.\n\nAdded at the end.\n';
    assert.deepEqual(diffDocument(blocks(original), blocks(current), { budgetMs: 0 }), [
      { op: 'ins', line: 4 },
      { op: 'ins', line: 6 },
      { op: 'del', oldLine: 4, before: 4 },
      { op: 'del', oldLine: 6, before: 4 },
    ]);
  });
});

describe('alignBlocks time budget', () => {
  const p = (text: string) => ({ kind: 'p', text });

  it('is unlimited by default and when the clock stays within the budget', () => {
    const old = [p('first block of text'), p('second block of text goes')];
    const now = [p('first block of changed text'), p('unrelated words entirely')];
    const expected = alignBlocks(old, now);
    assert.deepEqual(alignBlocks(old, now, { budgetMs: 1000, now: () => 5 }), expected);
    assert.ok(expected?.some((op) => op.op === 'modify'));
  });

  it('falls back to exact matches only: no modified blocks, no edited moves', () => {
    const old = [p('first block of text'), p('second block of text goes')];
    const now = [p('first block of changed text'), p('unrelated words entirely')];
    assert.deepEqual(alignBlocks(old, now, { budgetMs: 0 }), [
      { op: 'ins', b: 0 },
      { op: 'ins', b: 1 },
      { op: 'del', a: 0, before: 0 },
      { op: 'del', a: 1, before: 0 },
    ]);

    const edited = alignBlocks(
      [p('Retry policy uses exponential backoff with jitter and caps.'), p('anchor one'), p('anchor two')],
      [p('anchor one'), p('anchor two'), p('Retry policy uses exponential backoff with jitter and limits.')],
      { budgetMs: 0 },
    );
    assert.deepEqual(edited, [
      { op: 'ins', b: 2 },
      { op: 'del', a: 0, before: 0 },
    ]);
  });

  it('still finds exact matches and exact moves when out of time', () => {
    const moved = 'This paragraph moves to the end of the document.';
    const ops = alignBlocks([p(moved), p('anchor one'), p('anchor two')], [p('anchor one'), p('anchor two'), p(moved)], { budgetMs: 0 });
    assert.deepEqual(ops, [
      { op: 'moveTo', a: 0, b: 2, id: 0, edited: false },
      { op: 'moveFrom', a: 0, before: 0, id: 0 },
    ]);
  });

  it('runs out mid-way on an injected clock and still returns a consistent result', () => {
    // Two groups with their own words, in opposite order and each block edited: one group aligns
    // (6 modified), the other can only be found by move detection. The clock advances 1 ms per
    // reading, so the budget runs out part-way through move detection.
    const group = (prefix: string, edit: string) => Array.from({ length: 6 }, (_, i) => p(`${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => prefix + k).join(' ')} n${i}${edit}`));
    const old = [...group('alpha', ''), ...group('beta', '')];
    const now = [...group('beta', 'x'), ...group('alpha', 'x')];
    const count = (ops: ReturnType<typeof alignBlocks>, kind: string) => ops?.filter((op) => op.op === kind).length;

    let t = 0;
    const full = alignBlocks(old, now, { budgetMs: 1000, now: () => t++ });
    assert.equal(count(full, 'moveTo'), 6);

    t = 0;
    const partial = alignBlocks(old, now, { budgetMs: 20, now: () => t++ });
    assertConsistent(partial, old.length, now.length);
    assert.equal(count(partial, 'modify'), 6);
    const moves = count(partial, 'moveTo') ?? 0;
    assert.ok(moves > 0 && moves < 6, `expected some but not all moves, got ${moves}`);
    assert.equal(count(partial, 'moveFrom'), moves);
  });

  it('diffs large, mostly different documents within a bounded time', function () {
    this.timeout(30_000);
    const rand = rng(12345);
    const shuffle = <T>(a: T[]): T[] => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    // Two groups of 50 long blocks. Inside a group the blocks are different orderings of the same
    // words, so the word-bag score cannot tell them apart and only the ordered score can. The two
    // documents have the groups in opposite order: one group aligns, the other leaves 50 × 50
    // candidate pairs for move detection, each 1000 × 1000 tokens. Unbounded, that took ~13 s.
    const base = (prefix: string) => Array.from({ length: 1000 }, () => `${prefix}${Math.floor(rand() * 300)}`);
    const group = (words: string[]): SourceBlock[] => Array.from({ length: 50 }, () => ({ kind: 'paragraph_open', text: shuffle([...words]).join(' '), line: 0, end: 0 }));
    const lines = (list: SourceBlock[]): SourceBlock[] => list.map((b, i) => ({ ...b, line: i * 2, end: i * 2 + 1 }));
    const a = base('a');
    const b = base('b');
    const original = lines([...group(a), ...group(b)]);
    const current = lines([...group(b), ...group(a)]);

    const started = Date.now();
    const changes = diffDocument(original, current);
    const elapsed = Date.now() - started;

    assert.ok(changes, 'diffDocument returned no changes');
    // Every block differs from every other, so each one is part of some change.
    assert.equal(changes.filter((c) => c.op === 'ins' || c.op === 'moveTo' || c.op === 'modify').length, current.length);
    assert.equal(changes.filter((c) => c.op === 'del' || c.op === 'moveFrom' || c.op === 'modify').length, original.length);
    // Budget is 250 ms; the bound is far above it so a slow CI machine does not flake.
    assert.ok(elapsed < 10_000, `diffDocument took ${elapsed} ms`);
  });
});

/** Every old and new item is covered exactly once, by the operation kinds that may cover it. */
function assertConsistent(ops: ReturnType<typeof alignBlocks>, oldCount: number, newCount: number): void {
  assert.ok(ops, 'no ops');
  const oldSeen = new Set<number>();
  const newSeen = new Set<number>();
  for (const op of ops) {
    if (op.op === 'del' || op.op === 'moveFrom' || op.op === 'modify') {
      assert.ok(!oldSeen.has(op.a), `old ${op.a} twice`);
      oldSeen.add(op.a);
    }
    if (op.op === 'ins' || op.op === 'moveTo' || op.op === 'modify') {
      assert.ok(!newSeen.has(op.b), `new ${op.b} twice`);
      newSeen.add(op.b);
    }
  }
  // All items here differ from every counterpart, so none is left "unchanged".
  assert.equal(oldSeen.size, oldCount);
  assert.equal(newSeen.size, newCount);
}

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
