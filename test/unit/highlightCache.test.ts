import * as assert from 'node:assert/strict';
import hljs from 'highlight.js/lib/common';
import { LruCache, createCachedHighlighter } from '../../src/render/highlightCache';
import { createMarkdownRenderer } from '../../src/render/markdown';

describe('LruCache', () => {
  it('evicts the least recently used entry when over the entry limit', () => {
    const cache = new LruCache<string>({ maxEntries: 2, maxChars: 1000 });
    cache.set('a', 'A', 1);
    cache.set('b', 'B', 1);
    assert.equal(cache.get('a'), 'A'); // refreshes a, so b is now the oldest
    cache.set('c', 'C', 1);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 'A');
    assert.equal(cache.get('c'), 'C');
    assert.equal(cache.size, 2);
  });

  it('evicts by total cost and tracks it on replace and delete', () => {
    const cache = new LruCache<string>({ maxEntries: 100, maxChars: 10 });
    cache.set('a', 'A', 4);
    cache.set('b', 'B', 4);
    cache.set('c', 'C', 4); // 12 > 10: a goes
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.cost, 8);
    cache.set('b', 'B2', 2);
    assert.equal(cache.cost, 6);
    cache.delete('c');
    assert.equal(cache.cost, 2);
    assert.equal(cache.size, 1);
  });

  it('does not store an entry larger than the whole budget, and keeps the others', () => {
    const cache = new LruCache<string>({ maxEntries: 100, maxChars: 10 });
    cache.set('a', 'A', 4);
    cache.set('big', 'X', 11);
    assert.equal(cache.get('big'), undefined);
    assert.equal(cache.get('a'), 'A');
    // An oversized replacement drops the stale value rather than keeping it.
    cache.set('a', 'A2', 11);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.cost, 0);
  });
});

describe('createCachedHighlighter', () => {
  function counting() {
    const calls: Array<[string, string]> = [];
    const highlighter = createCachedHighlighter((code, language) => {
      calls.push([code, language]);
      return `<${language}>${code}</${language}>`;
    });
    return { calls, highlighter };
  }

  it('does not call the highlighter again for a hit', () => {
    const { calls, highlighter } = counting();
    assert.equal(highlighter('x = 1', 'python'), '<python>x = 1</python>');
    assert.equal(highlighter('x = 1', 'python'), '<python>x = 1</python>');
    assert.equal(calls.length, 1);
  });

  it('keeps the same content in different languages apart', () => {
    const { calls, highlighter } = counting();
    assert.equal(highlighter('a', 'js'), '<js>a</js>');
    assert.equal(highlighter('a', 'ts'), '<ts>a</ts>');
    assert.equal(highlighter('a', 'js'), '<js>a</js>');
    assert.equal(calls.length, 2);
    // A language name that ends where the code could begin must not alias another pair.
    assert.equal(highlighter('b', 'js'), '<js>b</js>');
    assert.equal(highlighter('jsb', ''), '<>jsb</>');
    assert.equal(calls.length, 4);
  });

  it('evicts old entries and highlights them again', () => {
    const calls: string[] = [];
    const highlighter = createCachedHighlighter(
      (code) => {
        calls.push(code);
        return code.toUpperCase();
      },
      { maxEntries: 2, maxChars: 1000 },
    );
    highlighter('a', 'x');
    highlighter('b', 'x');
    highlighter('a', 'x'); // hit, refreshes a
    highlighter('c', 'x'); // evicts b
    highlighter('a', 'x'); // still cached
    highlighter('b', 'x'); // evicted: highlighted again
    assert.deepEqual(calls, ['a', 'b', 'c', 'b']);
    assert.equal(highlighter.cache.size, 2);
  });

  it('does not cache a call that throws', () => {
    let attempts = 0;
    const highlighter = createCachedHighlighter(() => {
      attempts++;
      if (attempts === 1) throw new Error('boom');
      return 'ok';
    });
    assert.throws(() => highlighter('a', 'x'), /boom/);
    assert.equal(highlighter('a', 'x'), 'ok');
    assert.equal(highlighter('a', 'x'), 'ok');
    assert.equal(attempts, 2);
  });

  it('does not pin a block larger than the character budget', () => {
    const calls: string[] = [];
    const highlighter = createCachedHighlighter(
      (code) => {
        calls.push(code);
        return code;
      },
      { maxEntries: 10, maxChars: 50 },
    );
    const big = 'x'.repeat(100);
    highlighter(big, 'js');
    highlighter(big, 'js');
    assert.equal(calls.length, 2);
    assert.equal(highlighter.cache.size, 0);
  });
});

describe('markdown renderer highlight cache', () => {
  const render = createMarkdownRenderer();
  const opts = { mermaid: true };
  const src = [
    '---',
    'title: x',
    'list: [1, 2]',
    '---',
    '',
    '```js',
    'const a = "<b>" + 1; // c',
    '```',
    '',
    '```json',
    '{"a": [1, 2, true]}',
    '```',
    '',
    '```notalanguage',
    '<not highlighted>',
    '```',
    '',
    '```',
    'plain & simple',
    '```',
    '',
  ].join('\n');

  it('renders the same HTML cold and warm, equal to uncached highlight.js output', () => {
    const cold = render(src, opts).html;
    const warm = render(src, opts).html;
    assert.equal(warm, cold);
    const expectJs = hljs.highlight('const a = "<b>" + 1; // c\n', { language: 'js', ignoreIllegals: true }).value;
    assert.ok(cold.includes(`<code class="hljs language-js">${expectJs}</code>`));
    const expectYaml = hljs.highlight('title: x\nlist: [1, 2]', { language: 'yaml', ignoreIllegals: true }).value;
    assert.ok(cold.includes(`<code class="hljs language-yaml">${expectYaml}</code>`));
    assert.ok(cold.includes('<code class="hljs">plain &amp; simple\n</code>'));
    assert.ok(cold.includes('<code class="hljs">&lt;not highlighted&gt;\n</code>'));
  });

  it('does not mix up the same code in different languages', () => {
    const code = '{"a": 1}\n';
    const html = render('```json\n' + code + '```\n\n```js\n' + code + '```\n', opts).html;
    const json = hljs.highlight(code, { language: 'json', ignoreIllegals: true }).value;
    const js = hljs.highlight(code, { language: 'js', ignoreIllegals: true }).value;
    assert.notEqual(json, js);
    assert.ok(html.includes(`<code class="hljs language-json">${json}</code>`));
    assert.ok(html.includes(`<code class="hljs language-js">${js}</code>`));
  });
});
