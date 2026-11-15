import * as assert from 'node:assert/strict';
import { diffDocument } from '../../src/diff/blockDiff';
import type { BlockChange } from '../../src/protocol';
import { createMarkdownRenderer } from '../../src/render/markdown';
import { applyChanges, CHANGED_SELECTOR, indexBaseline, REMOVED_SELECTOR } from '../../webview/changes';
import { sanitize } from '../../webview/sanitize';
import { useDom } from './dom';

const render = createMarkdownRenderer();
const OPTS = { mermaid: true };

type Mode = 'inline' | 'gutter';

/** The preview root after `main.ts` would have rendered `current` against `original` (via the real renderer and diff). */
function run(original: string, current: string, mode: Mode): { root: HTMLElement; ops: BlockChange[] } {
  const before = render(original, OPTS);
  const after = render(current, OPTS);
  const ops = diffDocument(before.topBlocks, after.topBlocks);
  assert.ok(ops, 'diffDocument returned no ops');
  const root = document.createElement('div');
  root.replaceChildren(sanitize(after.html));
  applyChanges(root, ops, indexBaseline(before.html), mode);
  return { root, ops };
}

/** Applies hand-written ops to hand-written HTML (for cases the real diff does not produce). */
function runOps(originalHtml: string, html: string, ops: BlockChange[], mode: Mode): HTMLElement {
  const root = document.createElement('div');
  root.replaceChildren(sanitize(html));
  applyChanges(root, ops, indexBaseline(originalHtml), mode);
  return root;
}

const q = (root: Element, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
const only = (root: Element, selector: string): HTMLElement => {
  const found = q(root, selector);
  assert.equal(found.length, 1, `expected exactly one ${selector}, got ${found.length}`);
  return found[0];
};
/** Text of `el` as the current document reads (inserted text kept, removed text dropped). */
function newText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('del.rm-del').forEach((d) => d.remove());
  return copy.textContent ?? '';
}
/** Text of `el` as the original read (inserted text dropped, removed text kept). */
function oldText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('ins.rm-ins').forEach((d) => d.remove());
  return copy.textContent ?? '';
}

/** A removed clone carries no source positions, ids or editor context, on itself or anything inside it. */
function assertStripped(clone: Element): void {
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of ['data-line', 'data-line-end', 'data-item-end', 'id', 'data-vscode-context']) {
      assert.equal(el.hasAttribute(attr), false, `<${el.localName}> still has ${attr}`);
    }
  }
}

const PARAS = 'The quick brown fox jumps over the lazy dog.\n\nSecond paragraph stays here.\n\nThird paragraph about cats.\n\nFourth paragraph about dogs and birds.\n';

describe('changes (webview)', () => {
  useDom();

  describe('selectors', () => {
    it('REMOVED_SELECTOR covers removed and moved-from blocks only', () => {
      assert.equal(REMOVED_SELECTOR, '.rm-chg-del, .rm-chg-move-from');
      for (const cls of ['rm-chg-ins', 'rm-chg-mod', 'rm-chg-del', 'rm-chg-move-to', 'rm-chg-move-from']) {
        assert.ok(CHANGED_SELECTOR.includes(cls));
      }
    });
  });

  describe('unchanged documents', () => {
    it('changes nothing without ops', () => {
      const { root } = run(PARAS, PARAS, 'inline');
      const html = root.innerHTML;
      assert.equal(q(root, CHANGED_SELECTOR).length, 0);
      assert.equal(root.innerHTML, html);
      assert.equal(q(root, 'ins, del').length, 0);
    });
  });

  describe('added blocks', () => {
    for (const mode of ['inline', 'gutter'] as const) {
      it(`tags an added paragraph rm-chg-ins (${mode})`, () => {
        const { root } = run(PARAS, PARAS.replace('Third paragraph about cats.', 'Third paragraph about cats.\n\nBrand new closing note.'), mode);
        const added = only(root, '.rm-chg-ins');
        assert.equal(added.tagName, 'P');
        assert.equal(added.textContent, 'Brand new closing note.');
        assert.equal(q(root, CHANGED_SELECTOR).length, 1, 'only the added block is tagged');
        assert.equal(added.dataset.lineEnd !== undefined, true, 'added block keeps its source positions');
      });
    }

    it('tags an added list item inside a modified list', () => {
      const { root } = run('- one apple\n- two pears\n', '- one apple\n- two pears\n- three plums\n', 'inline');
      const added = only(root, '.rm-chg-ins');
      assert.equal(added.tagName, 'LI');
      assert.equal(added.textContent, 'three plums');
      assert.equal(q(root, 'ul > li').length, 3);
    });
  });

  describe('modified blocks, inline mode', () => {
    it('wraps changed words in ins.rm-ins and del.rm-del', () => {
      const { root } = run(PARAS, PARAS.replace('brown fox', 'red fox').replace('lazy dog.', 'lazy dog today.'), 'inline');
      const p = only(root, 'p.rm-chg-mod');
      assert.equal(only(p, 'del.rm-del').textContent, 'brown');
      assert.deepEqual(
        q(p, 'ins.rm-ins').map((i) => i.textContent),
        ['red', ' today'],
      );
      assert.equal(newText(p), 'The quick red fox jumps over the lazy dog today.');
      assert.equal(oldText(p), 'The quick brown fox jumps over the lazy dog.');
    });

    it('leaves unchanged blocks untouched', () => {
      const { root } = run(PARAS, PARAS.replace('brown', 'red'), 'inline');
      assert.equal(q(root, CHANGED_SELECTOR).length, 1);
      assert.equal(q(root, 'p').length, 4);
    });

    it('shows a pure insertion without any del', () => {
      const { root } = run('Hello world.\n', 'Hello big world.\n', 'inline');
      const p = only(root, 'p');
      assert.equal(q(p, 'del').length, 0);
      assert.equal(newText(p), 'Hello big world.');
      assert.ok(q(p, 'ins.rm-ins').length >= 1);
    });

    it('keeps inline formatting when a changed range spans an element', () => {
      const { root } = run('Read the **old manual** now.\n', 'Read the **new manual** now.\n', 'inline');
      const p = only(root, 'p');
      assert.equal(only(p, 'strong').tagName, 'STRONG');
      assert.equal(newText(p), 'Read the new manual now.');
      assert.equal(oldText(p), 'Read the old manual now.');
    });

    it('diffs a list item word by word, leaving other items alone', () => {
      const { root } = run('- one apple\n- two pears\n- three plums\n', '- one apple\n- two ripe pears\n- three plums\n', 'inline');
      const mod = only(root, 'li.rm-chg-mod');
      assert.equal(only(mod, 'ins.rm-ins').textContent, 'ripe ');
      assert.equal(q(root, 'li').length, 3);
      assert.equal(q(root, 'li').filter((li) => li.classList.contains('rm-chg-mod')).length, 1);
    });

    it('diffs a table cell in place', () => {
      const { root } = run('| A | B |\n|---|---|\n| 1 | 2 |\n', '| A | B |\n|---|---|\n| 1 | 3 |\n', 'inline');
      const cell = only(root, 'td.rm-chg-mod');
      assert.equal(only(cell, 'del.rm-del').textContent, '2');
      assert.equal(only(cell, 'ins.rm-ins').textContent, '3');
      assert.equal(q(root, 'tbody > tr').length, 1);
    });

    it('diffs code blocks line by line', () => {
      const { root } = run('```js\nconst a = 1;\nconst b = 2;\n```\n', '```js\nconst a = 1;\nconst b = 3;\n```\n', 'inline');
      const pre = only(root, 'pre.rm-chg-mod');
      assert.ok(q(pre, 'del.rm-del').some((d) => d.textContent?.includes('const b = 2;')));
      assert.ok(newText(pre).includes('const b = 3;'));
      assert.ok(!newText(pre).includes('const b = 2;'));
    });

    it('flags a block whose markup changed but not its text', () => {
      const { root } = run('[docs](a.md)\n', '[docs](b.md)\n', 'inline');
      const p = only(root, 'p');
      assert.ok(p.classList.contains('rm-chg-mod'));
      assert.equal(q(p, 'ins, del').length, 0);
    });

    it('shows a rewritten block as removed + added instead of a word diff', () => {
      const { root } = run('The quick brown fox jumps over the lazy dog.\n', 'Totally unrelated sentence zebra.\n', 'inline');
      const removed = only(root, '.rm-chg-del');
      const added = only(root, '.rm-chg-ins');
      assert.equal(removed.textContent, 'The quick brown fox jumps over the lazy dog.');
      assert.equal(added.textContent, 'Totally unrelated sentence zebra.');
      assert.equal(removed.nextElementSibling, added);
      assert.equal(q(root, 'ins, del').length, 0);
    });

    it('falls back to tagging when the original block is unknown', () => {
      const root = runOps('', '<p data-line="0" data-line-end="1">now</p>', [{ op: 'modify', oldLine: 5, line: 0 }], 'inline');
      assert.ok(only(root, 'p').classList.contains('rm-chg-mod'));
    });
  });

  describe('removed blocks, inline mode', () => {
    it('clones a removed block in from originalHtml in front of the following block', () => {
      const { root } = run(PARAS, PARAS.replace('Third paragraph about cats.\n\n', ''), 'inline');
      const clone = only(root, '.rm-chg-del');
      assert.equal(clone.textContent, 'Third paragraph about cats.');
      assert.equal(clone.getAttribute('aria-label'), 'Removed');
      assert.equal(clone.nextElementSibling?.textContent, 'Fourth paragraph about dogs and birds.');
      assert.equal(clone.previousElementSibling?.textContent, 'Second paragraph stays here.');
    });

    it('strips data-line*, data-item-end and ids from the clone and everything inside it', () => {
      const original = '# Title\n\nKeep.\n\n## Gone heading\n\n- one\n- two\n\nTail.\n';
      const { root } = run(original, '# Title\n\nKeep.\n\nTail.\n', 'inline');
      const removed = q(root, '.rm-chg-del');
      assert.equal(removed.length, 2);
      assert.deepEqual(
        removed.map((r) => r.tagName),
        ['H2', 'UL'],
      );
      for (const clone of removed) {
        for (const el of [clone, ...q(clone, '*')]) {
          for (const attr of ['data-line', 'data-line-end', 'data-item-end', 'id', 'data-vscode-context']) {
            assert.equal(el.hasAttribute(attr), false, `<${el.tagName.toLowerCase()}> still has ${attr}`);
          }
        }
      }
      // The live blocks keep theirs.
      assert.equal(root.querySelector('#title')?.hasAttribute('data-line'), true);
    });

    it('does not leave stale ids that would collide with real headings', () => {
      const { root } = run('# Same\n\nbody\n', 'body\n\n# Same\n', 'inline');
      const ids = q(root, '[id]').map((e) => e.id);
      assert.deepEqual(ids, ['same']);
    });

    it('disables checkboxes in removed list items', () => {
      const { root } = run('Intro.\n\n- [ ] todo item\n', 'Intro.\n', 'inline');
      const input = only(root, '.rm-chg-del input');
      assert.equal((input as HTMLInputElement).disabled, true);
    });

    it('appends a block removed at the end of the document', () => {
      const { root } = run('# A\n\ntext\n\n---\n', '# A\n\ntext\n', 'inline');
      const clone = only(root, '.rm-chg-del');
      assert.equal(clone.tagName, 'HR');
      assert.equal(root.lastElementChild, clone);
    });

    it('shows a removed list item in place inside the list', () => {
      const { root } = run('- one apple\n- two pears\n- three plums\n', '- one apple\n- three plums\n', 'inline');
      const clone = only(root, 'ul > li.rm-chg-del');
      assert.equal(clone.textContent, 'two pears');
      assert.equal(clone.previousElementSibling?.textContent, 'one apple');
      assert.equal(clone.nextElementSibling?.textContent, 'three plums');
      assert.equal(clone.hasAttribute('data-item-end'), false);
    });

    it('ignores a removal whose original block is unknown', () => {
      const root = runOps('', '<p data-line="0" data-line-end="1">x</p>', [{ op: 'del', oldLine: 9, before: 0 }], 'inline');
      assert.equal(root.children.length, 1);
    });
  });

  describe('gutter mode', () => {
    it('only tags: no clones, no ins/del', () => {
      const current = PARAS.replace('brown fox', 'red fox').replace('Third paragraph about cats.', 'Brand new paragraph.').replace('Second paragraph stays here.\n\n', '');
      const { root } = run(PARAS, current, 'gutter');
      assert.equal(q(root, REMOVED_SELECTOR).length, 0);
      assert.equal(q(root, 'ins, del').length, 0);
      assert.equal(q(root, 'p').length, 3, 'no element is added to the document');
      assert.ok(q(root, 'p.rm-chg-mod, p.rm-chg-ins').length >= 1);
    });

    it('tags a modified paragraph as a whole without touching its text', () => {
      const { root } = run(PARAS, PARAS.replace('brown fox', 'red fox'), 'gutter');
      const p = only(root, '.rm-chg-mod');
      assert.equal(p.textContent, 'The quick red fox jumps over the lazy dog.');
      assert.equal(p.children.length, 0);
    });

    it('marks the block that followed removed content with data-rm-del-before', () => {
      const { root } = run(PARAS, PARAS.replace('Third paragraph about cats.\n\n', ''), 'gutter');
      const next = only(root, '[data-rm-del-before]');
      assert.equal(next.textContent, 'Fourth paragraph about dogs and birds.');
      assert.equal(q(root, 'p').length, 3);
      assert.equal(q(root, CHANGED_SELECTOR).length, 0);
    });

    it('marks the last block with data-rm-del-after when the removal was at the end', () => {
      const { root } = run('# A\n\ntext\n\nlast\n', '# A\n\ntext\n', 'gutter');
      const last = only(root, '[data-rm-del-after]');
      assert.equal(last.textContent, 'text');
      assert.equal(q(root, '[data-rm-del-before]').length, 0);
    });

    it('marks removals inside a list on the item that follows', () => {
      const { root } = run('- one apple\n- two pears\n- three plums\n', '- one apple\n- three plums\n', 'gutter');
      assert.equal(q(root, 'li').length, 2);
      assert.equal(only(root, 'li[data-rm-del-before]').textContent, 'three plums');
    });

    it('still tags added list items', () => {
      const { root } = run('- one apple\n', '- one apple\n- two pears\n', 'gutter');
      assert.equal(only(root, 'li.rm-chg-ins').textContent, 'two pears');
    });
  });

  describe('moved blocks', () => {
    const ORIGINAL = 'Alpha block of text one.\n\nBeta block of text two.\n\nGamma block of text three.\n\nDelta block of text four.\n';
    const MOVED = 'Beta block of text two.\n\nGamma block of text three.\n\nDelta block of text four.\n\nAlpha block of text one.\n';

    it('produces a moveTo / moveFrom pair from the real diff', () => {
      const { ops } = run(ORIGINAL, MOVED, 'inline');
      assert.deepEqual(ops.map((o) => o.op).sort(), ['moveFrom', 'moveTo']);
    });

    it('inline: tags the new place move-to and clones the old place as move-from with the same id', () => {
      const { root } = run(ORIGINAL, MOVED, 'inline');
      const to = only(root, '.rm-chg-move-to');
      const from = only(root, '.rm-chg-move-from');
      assert.equal(to.textContent, 'Alpha block of text one.');
      assert.equal(from.textContent, 'Alpha block of text one.');
      assert.ok(to.dataset.moveId);
      assert.equal(from.dataset.moveId, to.dataset.moveId);
      assert.equal(from.getAttribute('aria-label'), 'Moved from here');
      assert.equal(from.hasAttribute('data-line'), false);
      assert.equal(from.hasAttribute('data-line-end'), false);
      assert.equal(root.firstElementChild, from, 'moved-from sits where the block used to be');
      assert.equal(root.lastElementChild, to);
    });

    it('gutter: tags move-to with a move id but adds no clone', () => {
      const { root } = run(ORIGINAL, MOVED, 'gutter');
      const to = only(root, '.rm-chg-move-to');
      assert.ok(to.dataset.moveId);
      assert.equal(q(root, '.rm-chg-move-from').length, 0);
      assert.equal(q(root, 'p').length, 4);
    });

    it('gives each move its own id', () => {
      const original = 'Alpha one.\n\nBeta two two.\n\nGamma three three three.\n\nDelta four four four four.\n\nEpsilon five five five five five.\n';
      const current = 'Gamma three three three.\n\nDelta four four four four.\n\nEpsilon five five five five five.\n\nBeta two two.\n\nAlpha one.\n';
      const { root } = run(original, current, 'inline');
      const toIds = q(root, '.rm-chg-move-to').map((e) => e.dataset.moveId);
      const fromIds = q(root, '.rm-chg-move-from').map((e) => e.dataset.moveId);
      assert.equal(new Set(toIds).size, toIds.length);
      assert.deepEqual([...toIds].sort(), [...fromIds].sort());
    });

    it('inline: word-diffs a moved block that was also edited (hand-written ops)', () => {
      const original = '<p data-line="0" data-line-end="1">Alpha block of text one.</p><p data-line="2" data-line-end="3">Beta block.</p>';
      const current = '<p data-line="0" data-line-end="1">Beta block.</p><p data-line="2" data-line-end="3">Alpha block of text one, edited.</p>';
      const ops: BlockChange[] = [
        { op: 'moveFrom', oldLine: 0, before: 0, id: 0 },
        { op: 'moveTo', oldLine: 0, line: 2, id: 0, edited: true },
      ];
      const root = runOps(original, current, ops, 'inline');
      const to = only(root, '.rm-chg-move-to');
      assert.equal(only(to, 'ins.rm-ins').textContent, ', edited');
      assert.equal(oldText(to), 'Alpha block of text one.');
      assert.ok(to.classList.contains('rm-chg-mod'), 'the text edit is flagged as well');
    });

    it('gutter: does not word-diff an edited moved block', () => {
      const original = '<p data-line="0" data-line-end="1">Alpha block.</p><p data-line="2" data-line-end="3">Beta block.</p>';
      const current = '<p data-line="0" data-line-end="1">Beta block.</p><p data-line="2" data-line-end="3">Alpha block, edited.</p>';
      const ops: BlockChange[] = [
        { op: 'moveFrom', oldLine: 0, before: 0, id: 3 },
        { op: 'moveTo', oldLine: 0, line: 2, id: 3, edited: true },
      ];
      const root = runOps(original, current, ops, 'gutter');
      assert.equal(only(root, '.rm-chg-move-to').dataset.moveId, 'b3');
      assert.equal(q(root, 'ins, del').length, 0);
    });
  });

  describe('opaque blocks', () => {
    // `OPAQUE` = .rm-mermaid, hr, img, video, iframe, svg: no word diff, shown as removed + added.
    // Through the real renderer these reach `diffBlock` as a modify when they sit directly in a
    // blockquote, at top level as a raw HTML block (see 'raw HTML blocks') or, for Mermaid, as a fence.
    // An `iframe` is dropped by the sanitizer, so it never reaches the diff.
    const mermaid = (edge: string) => `\`\`\`mermaid\ngraph TD\n${edge}\n\`\`\`\n`;

    it('inline: replaces a changed Mermaid diagram with the old one as removed and the new one as added', () => {
      const { root } = run(mermaid('A-->B'), mermaid('A-->C'), 'inline');
      const removed = only(root, '.rm-chg-del');
      const added = only(root, '.rm-chg-ins');
      assert.ok(removed.matches('div.rm-mermaid'));
      assert.ok(added.matches('div.rm-mermaid'));
      assert.ok(removed.textContent?.includes('A-->B'));
      assert.ok(added.textContent?.includes('A-->C'));
      assert.equal(removed.getAttribute('aria-label'), 'Removed');
      assertStripped(removed);
      assert.equal(added.dataset.line, '0', 'the live diagram keeps its source position');
      assert.equal(removed.nextElementSibling, added);
      assert.equal(q(root, CHANGED_SELECTOR).length, 2);
      assert.equal(q(root, 'ins, del').length, 0, 'no word diff inside a diagram');
    });

    it('gutter: tags a changed Mermaid diagram as modified without a clone', () => {
      const { root } = run(mermaid('A-->B'), mermaid('A-->C'), 'gutter');
      const mod = only(root, '.rm-chg-mod');
      assert.ok(mod.matches('div.rm-mermaid'));
      assert.ok(mod.textContent?.includes('A-->C'));
      assert.equal(q(root, CHANGED_SELECTOR).length, 1);
      assert.equal(q(root, 'ins, del').length, 0);
    });

    const quoted = (...lines: string[]) => `${['> quoted intro text', '>', ...lines.map((l) => `> ${l}`)].join('\n')}\n`;
    const src = (el: Element) => el.getAttribute('src');
    const cases = [
      { tag: 'img', before: ['<img src="a.png" alt="x">'], after: ['<img src="b.png" alt="y">'], version: src, old: 'a.png', now: 'b.png' },
      {
        tag: 'svg',
        before: ['<svg width="10">', '<circle r="3"/>', '</svg>'],
        after: ['<svg width="10">', '<circle r="5"/>', '</svg>'],
        version: (el: Element) => el.querySelector('circle')?.getAttribute('r'),
        old: '3',
        now: '5',
      },
      { tag: 'video', before: ['<video src="a.mp4">', '</video>'], after: ['<video src="b.mp4">', '</video>'], version: src, old: 'a.mp4', now: 'b.mp4' },
      { tag: 'hr', before: ['<hr class="a">'], after: ['<hr class="b">'], version: (el: Element) => (el.classList.contains('a') ? 'a' : 'b'), old: 'a', now: 'b' },
    ];
    for (const c of cases) {
      it(`inline: replaces a changed <${c.tag}> inside a quote with a removed clone and an added element`, () => {
        const { root } = run(quoted(...c.before), quoted(...c.after), 'inline');
        const removed = only(root, '.rm-chg-del');
        const added = only(root, '.rm-chg-ins');
        assert.equal(removed.localName, c.tag);
        assert.equal(added.localName, c.tag);
        assert.equal(c.version(removed), c.old);
        assert.equal(c.version(added), c.now);
        assert.equal(removed.parentElement, only(root, 'blockquote'));
        assert.equal(removed.nextElementSibling, added);
        assert.equal(removed.getAttribute('aria-label'), 'Removed');
        assertStripped(removed);
        assert.equal(q(root, CHANGED_SELECTOR).length, 2, 'the quote and its intro are left alone');
        assert.equal(q(root, 'ins, del').length, 0);
      });

      it(`gutter: tags a changed <${c.tag}> inside a quote as modified without a clone`, () => {
        const { root } = run(quoted(...c.before), quoted(...c.after), 'gutter');
        const mod = only(root, '.rm-chg-mod');
        assert.equal(mod.localName, c.tag);
        assert.equal(c.version(mod), c.now);
        assert.equal(q(root, CHANGED_SELECTOR).length, 1);
        assert.equal(q(root, 'ins, del').length, 0);
      });
    }

    for (const mode of ['inline', 'gutter'] as const) {
      it(`only flags an image-only paragraph whose source changed: a <p> is not opaque (${mode})`, () => {
        const { root } = run('Intro text here.\n\n![alt one](a.png)\n', 'Intro text here.\n\n![alt one](b.png)\n', mode);
        const p = only(root, 'p.rm-chg-mod');
        assert.equal(p.querySelector('img')?.getAttribute('src'), 'b.png');
        assert.equal(q(root, CHANGED_SELECTOR).length, 1);
        assert.equal(q(root, 'ins, del').length, 0);
      });
    }

    it('top-level hr (hand-written ops: the real diff reports a changed rule as removed + added)', () => {
      const original = '<hr data-line="0" data-line-end="1" class="a">';
      const current = '<hr data-line="0" data-line-end="1" class="b">';
      const ops: BlockChange[] = [{ op: 'modify', oldLine: 0, line: 0 }];
      const inline = runOps(original, current, ops, 'inline');
      assert.equal(q(inline, 'hr').length, 2);
      const removed = only(inline, 'hr.rm-chg-del');
      assert.ok(removed.classList.contains('a'));
      assertStripped(removed);
      const added = only(inline, 'hr.rm-chg-ins');
      assert.ok(added.classList.contains('b'));
      assert.equal(added.dataset.line, '0');
      assert.equal(removed.nextElementSibling, added);

      const gutter = runOps(original, current, ops, 'gutter');
      assert.equal(q(gutter, 'hr').length, 1);
      assert.ok(only(gutter, 'hr.rm-chg-mod').classList.contains('b'));
    });
  });

  describe('tables', () => {
    const table = (cols: number) => {
      const row = (cell: (i: number) => string) => `| ${Array.from({ length: cols }, (_, i) => cell(i)).join(' | ')} |`;
      return `${[row((i) => 'ABCD'[i]), row(() => '---'), row((i) => String(i + 1))].join('\n')}\n`;
    };

    for (const [from, to] of [
      [2, 3],
      [3, 2],
    ]) {
      it(`inline: shows each row as removed + added when the column count changes (${from} -> ${to})`, () => {
        const { root } = run(table(from), table(to), 'inline');
        const removed = q(root, 'tr.rm-chg-del');
        const added = q(root, 'tr.rm-chg-ins');
        assert.equal(removed.length, 2, 'header row and body row');
        assert.equal(added.length, 2);
        assert.deepEqual(
          removed.map((r) => r.parentElement?.localName),
          ['thead', 'tbody'],
        );
        removed.forEach((row, i) => {
          assert.equal(row.nextElementSibling, added[i]);
          assert.equal(row.children.length, from);
          assert.equal(added[i].children.length, to);
          assert.equal(row.getAttribute('aria-label'), 'Removed');
          assertStripped(row);
        });
        assert.equal(q(root, CHANGED_SELECTOR).length, 4);
        assert.equal(q(root, 'ins, del').length, 0, 'no cell-level diff when the shapes differ');
      });

      it(`gutter: tags each row as modified when the column count changes (${from} -> ${to})`, () => {
        const { root } = run(table(from), table(to), 'gutter');
        const rows = q(root, 'tr.rm-chg-mod');
        assert.deepEqual(
          rows.map((r) => r.parentElement?.localName),
          ['thead', 'tbody'],
        );
        assert.equal(q(root, CHANGED_SELECTOR).length, 2);
        assert.equal(q(root, 'tr').length, 2, 'no clone rows');
      });
    }

    it('inline: shows a removed row in place after the last remaining row', () => {
      const { root } = run('| A | B |\n|---|---|\n| one | two |\n| three | four |\n', '| A | B |\n|---|---|\n| one | two |\n', 'inline');
      const removed = only(root, 'tbody > tr.rm-chg-del');
      assert.equal(removed.textContent?.replace(/\s+/g, ' ').trim(), 'three four');
      assert.equal(root.querySelector('tbody')?.lastElementChild, removed);
      assert.equal(removed.hasAttribute('data-line'), false);
      assert.equal(q(root, 'tbody > tr').length, 2);
    });

    it('gutter: marks the last remaining row with data-rm-del-after for a removed last row', () => {
      const { root } = run('| A | B |\n|---|---|\n| one | two |\n| three | four |\n', '| A | B |\n|---|---|\n| one | two |\n', 'gutter');
      const last = only(root, '[data-rm-del-after]');
      assert.equal(last.localName, 'tr');
      assert.equal(last.textContent?.replace(/\s+/g, ' ').trim(), 'one two');
      assert.equal(q(root, 'tr').length, 2);
    });

    for (const mode of ['inline', 'gutter'] as const) {
      it(`tags an added body row rm-chg-ins (${mode})`, () => {
        const { root } = run('| A | B |\n|---|---|\n| one | two |\n', '| A | B |\n|---|---|\n| one | two |\n| three | four |\n', mode);
        const added = only(root, 'tr.rm-chg-ins');
        assert.equal(added.parentElement?.localName, 'tbody');
        assert.equal(added.textContent?.replace(/\s+/g, ' ').trim(), 'three four');
        assert.equal(q(root, CHANGED_SELECTOR).length, 1);
      });
    }

    it('inline: appends a removed row to an empty tbody (hand-written: markdown tables always have rows)', () => {
      const original = '<table data-line="0" data-line-end="3"><tbody><tr data-line="2"><td>gone</td></tr></tbody></table>';
      const current = '<table data-line="0" data-line-end="3"><tbody></tbody></table>';
      const root = runOps(original, current, [{ op: 'modify', oldLine: 0, line: 0 }], 'inline');
      const removed = only(root, 'tbody > tr.rm-chg-del');
      assert.equal(removed.textContent, 'gone');
      assert.equal(removed.hasAttribute('data-line'), false);
    });

    it('gutter: with no row left, the removal is remembered on the last element of the table', () => {
      const original = '<table data-line="0" data-line-end="3"><tbody><tr data-line="2"><td>gone</td></tr></tbody></table>';
      const current = '<table data-line="0" data-line-end="3"><tbody></tbody></table>';
      const root = runOps(original, current, [{ op: 'modify', oldLine: 0, line: 0 }], 'gutter');
      assert.equal(only(root, '[data-rm-del-after]').localName, 'tbody');
      assert.equal(q(root, 'tr').length, 0);
    });
  });

  describe('blockquotes', () => {
    it('inline: word-diffs only the quoted block that changed', () => {
      const { root } = run('> first quoted para text\n>\n> second quoted para text\n', '> first quoted para text\n>\n> second quoted para text changed\n', 'inline');
      const mod = only(root, 'blockquote > p.rm-chg-mod');
      assert.equal(only(mod, 'ins.rm-ins').textContent, ' changed');
      assert.equal(q(root, 'del').length, 0);
      assert.equal(q(root, CHANGED_SELECTOR).length, 1);
      assert.equal(only(root, 'blockquote').classList.contains('rm-chg-mod'), false);
    });

    it('tags an added quoted block (both modes)', () => {
      for (const mode of ['inline', 'gutter'] as const) {
        const { root } = run('> first quoted para text\n', '> first quoted para text\n>\n> second quoted para text\n', mode);
        const added = only(root, 'blockquote > p.rm-chg-ins');
        assert.equal(added.textContent, 'second quoted para text');
        assert.equal(q(root, CHANGED_SELECTOR).length, 1, mode);
      }
    });

    it('inline: shows a removed last quoted block after the remaining one', () => {
      const { root } = run('> first quoted para text\n>\n> second quoted para text\n', '> first quoted para text\n', 'inline');
      const removed = only(root, 'blockquote > p.rm-chg-del');
      assert.equal(removed.textContent, 'second quoted para text');
      assert.equal(removed.previousElementSibling?.textContent, 'first quoted para text');
      assert.equal(removed.nextElementSibling, null);
      assertStripped(removed);
    });

    it('gutter: marks the last remaining quoted block with data-rm-del-after', () => {
      const { root } = run('> first quoted para text\n>\n> second quoted para text\n', '> first quoted para text\n', 'gutter');
      const last = only(root, '[data-rm-del-after]');
      assert.equal(last.textContent, 'first quoted para text');
      assert.equal(q(root, 'blockquote > p').length, 1);
    });

    it('inline: shows a removed first quoted block in front of the remaining one', () => {
      const { root } = run('> first quoted para text\n>\n> second quoted para text\n', '> second quoted para text\n', 'inline');
      const removed = only(root, 'blockquote > p.rm-chg-del');
      assert.equal(removed.textContent, 'first quoted para text');
      assert.equal(removed.nextElementSibling?.textContent, 'second quoted para text');
      assert.equal(removed.previousElementSibling, null);
    });

    it('gutter: marks the block after a removed first quoted block with data-rm-del-before', () => {
      const { root } = run('> first quoted para text\n>\n> second quoted para text\n', '> second quoted para text\n', 'gutter');
      assert.equal(only(root, '[data-rm-del-before]').textContent, 'second quoted para text');
      assert.equal(q(root, 'blockquote > p').length, 1);
    });

    const original = '<blockquote data-line="0" data-line-end="1"><p data-line="0">old</p></blockquote>';
    const current = '<blockquote data-line="0" data-line-end="1"></blockquote>';

    it('inline: appends a removed block to a quote that is now empty (hand-written ops)', () => {
      const root = runOps(original, current, [{ op: 'modify', oldLine: 0, line: 0 }], 'inline');
      const quote = only(root, 'blockquote');
      assert.equal(quote.children.length, 1);
      assert.ok(quote.firstElementChild?.matches('p.rm-chg-del'));
      assert.equal(quote.textContent, 'old');
    });

    it('gutter: with nothing left to follow, remembers the removal on the empty quote itself (hand-written ops)', () => {
      const root = runOps(original, current, [{ op: 'modify', oldLine: 0, line: 0 }], 'gutter');
      const quote = only(root, 'blockquote');
      assert.equal(quote.dataset.rmDelAfter, '');
      assert.equal(quote.children.length, 0);
      assert.equal(q(root, '[data-rm-del-after]').length, 1);
    });
  });

  describe('removal at the end of an empty document', () => {
    it('inline: appends the clone as the only child', () => {
      const { root } = run('a para\n', '', 'inline');
      assert.equal(root.children.length, 1);
      assert.ok(root.firstElementChild?.matches('p.rm-chg-del'));
      assert.equal(root.textContent, 'a para');
    });

    it('gutter: remembers the removal on the root, which has no last element', () => {
      const { root } = run('a para\n', '', 'gutter');
      assert.equal(root.dataset.rmDelAfter, '');
      assert.equal(root.children.length, 0);
    });
  });

  describe('nested lists', () => {
    // A list item's own text is diffed without its nested lists, which are then aligned item by item.
    // The renderer writes `text\n<ul>…</ul>\n`: the whitespace touching the nested list (the end of the
    // text node in front of it, the node after it) is layout, not the item's own text. Adding or
    // removing a nested list must therefore not report a change of the parent's text.
    const blank = (root: Element) => {
      assert.equal(q(root, 'ins, del').length, 0, 'the whitespace around the nested list is not a text change');
      assert.equal(q(root, '.rm-chg-mod').length, 0, 'the parent item is not flagged as modified');
    };
    const ADDED = '- parent item text here\n  - child added\n- other item\n';
    const PLAIN = '- parent item text here\n- other item\n';
    const REMOVED = '- parent item text here\n  - child gone\n- other item\n';

    for (const mode of ['inline', 'gutter'] as const) {
      it(`tags an added nested list rm-chg-ins (${mode})`, () => {
        const { root } = run(PLAIN, ADDED, mode);
        const nested = only(root, 'li > ul.rm-chg-ins');
        assert.equal(nested.textContent?.trim(), 'child added');
        assert.equal(q(nested, 'li').length, 1);
        assert.equal(q(nested, CHANGED_SELECTOR).length, 0, 'the nested item is not tagged on its own');
        assert.equal(q(root, '.rm-chg-ins, .rm-chg-del, .rm-chg-move-to, .rm-chg-move-from').length, 1);
        assert.equal(q(root, 'ul > li').length, 3);
        blank(root);
      });
    }

    it('gutter: an added nested list leaves no removal marker', () => {
      const { root } = run(PLAIN, ADDED, 'gutter');
      assert.equal(q(root, '[data-rm-del-before], [data-rm-del-after]').length, 0);
    });

    for (const mode of ['inline', 'gutter'] as const) {
      it(`a nested list added to an item leaves the whitespace after the list alone (${mode})`, () => {
        const { root } = run(PLAIN, ADDED, mode);
        const nested = only(root, 'li > ul');
        assert.equal(nested.nextSibling?.nodeType, Node.TEXT_NODE, 'the whitespace after the list is not wrapped');
        assert.equal(nested.nextSibling?.textContent?.trim(), '');
        assert.equal(nested.nextElementSibling, null);
      });
    }

    it('inline: shows a removed nested list as a clone at the end of its parent item', () => {
      const { root } = run(REMOVED, PLAIN, 'inline');
      const clone = only(root, 'li > ul.rm-chg-del');
      assert.equal(clone.textContent?.trim(), 'child gone');
      assert.equal(clone.getAttribute('aria-label'), 'Removed');
      assertStripped(clone);
      const parent = clone.parentElement as HTMLElement;
      assert.equal(parent.firstChild?.textContent?.trim(), 'parent item text here');
      assert.equal(parent.lastElementChild, clone);
      assert.equal(q(root, 'ul ul').length, 1, 'only the clone is nested');
      assert.equal(q(root, 'ul > li').filter((li) => li.textContent?.includes('other item')).length, 1);
      assert.equal(q(root, REMOVED_SELECTOR).length, 1);
      assert.equal(q(root, '[data-rm-del-before], [data-rm-del-after]').length, 0, 'inline mode uses the clone, not a marker');
      blank(root);
    });

    it('gutter: a removed nested list leaves no clone, but a removal marker at the end of its parent item', () => {
      const { root } = run(REMOVED, PLAIN, 'gutter');
      assert.equal(q(root, 'ul ul').length, 0);
      assert.equal(q(root, REMOVED_SELECTOR).length, 0);
      assert.equal(q(root, 'ins, del').length, 0);
      const marked = only(root, '[data-rm-del-before], [data-rm-del-after]');
      assert.equal(marked.localName, 'li');
      assert.ok(marked.textContent?.includes('parent item text here'));
      assert.equal(marked.dataset.rmDelAfter, '', 'the tick is drawn at the bottom of the item');
      assert.equal(marked.dataset.rmDelBefore, undefined);
      blank(root);
    });

    it('gutter: removing one of two nested lists marks the item once, and the remaining list stays', () => {
      // A nested list of a different type is a separate `ul` / `ol` child of the item.
      const before = '- parent item text here\n  - child one\n\n  1. numbered two\n- other item\n';
      const after = '- parent item text here\n  - child one\n- other item\n';
      const { root } = run(before, after, 'gutter');
      assert.equal(q(root, 'li > ol').length, 0);
      assert.equal(only(root, 'li > ul').localName, 'ul');
      const marked = only(root, '[data-rm-del-before], [data-rm-del-after]');
      assert.equal(marked.dataset.rmDelAfter, '');
      assert.ok(marked.textContent?.includes('parent item text here'));
      assert.equal(q(root, 'ins, del').length, 0);
    });

    const NESTED = (last: string) => `- parent item text here\n  - child one two ${last}\n- other item\n`;

    it('inline: word-diffs a modified nested item and leaves the parent item alone', () => {
      const { root } = run(NESTED('three'), NESTED('four'), 'inline');
      const mod = only(root, 'li.rm-chg-mod');
      assert.equal(mod.parentElement?.parentElement?.localName, 'li', 'it is the nested item');
      assert.equal(only(mod, 'del.rm-del').textContent, 'three');
      assert.equal(only(mod, 'ins.rm-ins').textContent, 'four');
      assert.equal(newText(mod), 'child one two four');
      assert.equal(oldText(mod), 'child one two three');
      assert.equal(q(root, CHANGED_SELECTOR).length, 1);
      assert.equal(q(root, 'ul > li').filter((li) => li.classList.contains('rm-chg-mod')).length, 1);
    });

    it('gutter: tags only the modified nested item, text untouched', () => {
      const { root } = run(NESTED('three'), NESTED('four'), 'gutter');
      const mod = only(root, 'li.rm-chg-mod');
      assert.equal(mod.textContent, 'child one two four');
      assert.equal(mod.parentElement?.parentElement?.localName, 'li');
      assert.equal(q(root, CHANGED_SELECTOR).length, 1);
      assert.equal(q(root, 'ins, del').length, 0);
    });

    for (const mode of ['inline', 'gutter'] as const) {
      it(`tags an item added to an existing nested list (${mode})`, () => {
        const before = '- parent item text here\n  - child alpha one\n  - child beta two\n- other item\n';
        const after = '- parent item text here\n  - child alpha one\n  - child beta two\n  - child gamma three\n- other item\n';
        const { root } = run(before, after, mode);
        const added = only(root, 'li.rm-chg-ins');
        assert.equal(added.textContent, 'child gamma three');
        assert.equal(added.parentElement?.parentElement?.localName, 'li');
        assert.equal(q(root, CHANGED_SELECTOR).length, 1);
        assert.equal(q(root, 'ins, del').length, 0);
      });
    }
  });

  describe('moves inside blocks', () => {
    const ITEMS = ['Alpha item text one', 'Beta item text two', 'Gamma item text three', 'Delta item text four'];
    const bullets = (items: string[], suffix = '') => items.map((i) => `- ${i}${suffix}\n`).join('');
    const rotated = (items: string[]) => [...items.slice(1), items[0]];

    it('inline: pairs a moved list item with an n-prefixed id', () => {
      const { root, ops } = run(bullets(ITEMS), bullets(rotated(ITEMS)), 'inline');
      assert.deepEqual(
        ops.map((o) => o.op),
        ['modify'],
        'the list is one modified block; the move is found inside it',
      );
      const to = only(root, 'li.rm-chg-move-to');
      const from = only(root, 'li.rm-chg-move-from');
      assert.equal(to.dataset.moveId, 'n0');
      assert.equal(from.dataset.moveId, 'n0');
      assert.equal(to.textContent, 'Alpha item text one');
      assert.equal(from.textContent, 'Alpha item text one');
      assert.equal(from.getAttribute('aria-label'), 'Moved from here');
      assertStripped(from);
      assert.equal(from.parentElement?.firstElementChild, from, 'moved-from sits where the item used to be');
      assert.equal(to.parentElement?.lastElementChild, to);
      assert.equal(to.hasAttribute('data-item-end'), true, 'the live item keeps its position');
    });

    it('gutter: tags move-to with an n-prefixed id and adds no clone', () => {
      const { root } = run(bullets(ITEMS), bullets(rotated(ITEMS)), 'gutter');
      const to = only(root, 'li.rm-chg-move-to');
      assert.equal(to.dataset.moveId, 'n0');
      assert.equal(q(root, REMOVED_SELECTOR).length, 0);
      assert.equal(q(root, 'li').length, 4);
    });

    for (const mode of ['inline', 'gutter'] as const) {
      it(`gives moves in different blocks different ids (${mode})`, () => {
        const original = `${bullets(ITEMS)}\nMiddle paragraph between lists.\n\n${bullets(ITEMS, ' x')}`;
        const current = `${bullets(rotated(ITEMS))}\nMiddle paragraph between lists.\n\n${bullets(rotated(ITEMS), ' x')}`;
        const { root } = run(original, current, mode);
        const lists = q(root, 'ul');
        assert.equal(lists.length, 2);
        assert.deepEqual(
          lists.map((l) => only(l, 'li.rm-chg-move-to').dataset.moveId),
          ['n0', 'n1'],
        );
        if (mode === 'inline') {
          assert.deepEqual(
            lists.map((l) => only(l, 'li.rm-chg-move-from').dataset.moveId),
            ['n0', 'n1'],
          );
        }
      });
    }

    it('keeps top-level (b) and in-block (n) move ids apart', () => {
      const paras = ['Alpha block of text one.', 'Beta block of text two.', 'Gamma block of text three.', 'Delta block of text four.'];
      const doc = (p: string[], l: string[]) => `${p.join('\n\n')}\n\n${bullets(l)}`;
      const { root } = run(doc(paras, ITEMS), doc(rotated(paras), rotated(ITEMS)), 'inline');
      const ids = (selector: string) => q(root, selector).map((e) => e.dataset.moveId);
      assert.deepEqual(ids('p.rm-chg-move-to'), ['b0']);
      assert.deepEqual(ids('p.rm-chg-move-from'), ['b0']);
      assert.deepEqual(ids('li.rm-chg-move-to'), ['n0']);
      assert.deepEqual(ids('li.rm-chg-move-from'), ['n0']);
    });

    it('inline: word-diffs an in-block move that was edited too; gutter does not', () => {
      const edited = [...rotated(ITEMS).slice(0, 3), 'Alpha item text one now'];
      const inline = run(bullets(ITEMS), bullets(edited), 'inline').root;
      const to = only(inline, 'li.rm-chg-move-to');
      assert.equal(to.dataset.moveId, 'n0');
      assert.equal(only(to, 'ins.rm-ins').textContent, ' now');
      assert.equal(q(to, 'del').length, 0);
      assert.equal(oldText(to), 'Alpha item text one');
      assert.equal(only(inline, 'li.rm-chg-move-from').textContent, 'Alpha item text one');

      const gutter = run(bullets(ITEMS), bullets(edited), 'gutter').root;
      assert.equal(only(gutter, 'li.rm-chg-move-to').textContent, 'Alpha item text one now');
      assert.equal(q(gutter, 'ins, del').length, 0);
    });
  });

  describe('rewrites inside a block', () => {
    it('inline: shows a fully rewritten table cell as del + ins inside the cell', () => {
      const row = (last: string) => `| alpha one | beta two | gamma three | delta four | epsilon five | ${last} |`;
      const doc = (last: string) => `| A | B | C | D | E | F |\n|---|---|---|---|---|---|\n${row(last)}\n`;
      const { root } = run(doc('The quick brown fox'), doc('Totally unrelated zebra'), 'inline');
      const cell = only(root, 'td.rm-chg-mod');
      assert.equal(cell.children.length, 2);
      const del = only(cell, 'del.rm-del');
      const ins = only(cell, 'ins.rm-ins');
      assert.equal(del.textContent, 'The quick brown fox');
      assert.equal(ins.textContent, 'Totally unrelated zebra');
      assert.equal(del.nextElementSibling, ins, 'the old text comes first');
      assert.equal(newText(cell), 'Totally unrelated zebra');
      assert.equal(oldText(cell), 'The quick brown fox');
      assert.equal(q(root, CHANGED_SELECTOR).length, 1, 'the row is not replaced');
      assert.equal(q(root, 'tbody > tr').length, 1);
    });

    it('gutter: tags the rewritten cell without touching its text', () => {
      const doc = (last: string) => `| A | B | C | D | E | F |\n|---|---|---|---|---|---|\n| alpha one | beta two | gamma three | delta four | epsilon five | ${last} |\n`;
      const { root } = run(doc('The quick brown fox'), doc('Totally unrelated zebra'), 'gutter');
      const cell = only(root, 'td.rm-chg-mod');
      assert.equal(cell.textContent, 'Totally unrelated zebra');
      assert.equal(cell.children.length, 0);
      assert.equal(q(root, CHANGED_SELECTOR).length, 1);
    });

    it('inline: shows a list item whose own text was rewritten as del + ins, nested list untouched', () => {
      const doc = (first: string) => `- ${first}\n  - child one\n  - child two\n  - child three\n`;
      const { root } = run(doc('The quick brown fox'), doc('Totally unrelated zebra'), 'inline');
      const item = only(root, 'li.rm-chg-mod');
      const nested = only(item, 'ul');
      assert.equal(item.firstElementChild?.localName, 'del', 'old text first');
      assert.equal(item.firstElementChild?.textContent?.trim(), 'The quick brown fox');
      assert.ok(q(item, 'ins.rm-ins').some((i) => i.textContent?.includes('Totally unrelated zebra')));
      assert.equal(q(nested, 'ins, del').length, 0);
      assert.equal(q(nested, CHANGED_SELECTOR).length, 0);
      assert.equal(q(root, REMOVED_SELECTOR).length, 0, 'the item is not replaced by a clone');
      assert.equal(q(root, 'ul > li').length, 4);
    });

    it('inline: a rewritten list item keeps the nodes around its nested list where they were', () => {
      const doc = (first: string) => `- ${first}
  - child one
  - child two
  - child three
`;
      const current = doc('Totally unrelated zebra');
      const plain = document.createElement('div');
      plain.replaceChildren(sanitize(render(current, OPTS).html));
      const { root } = run(doc('The quick brown fox'), current, 'inline');
      const item = only(root, 'li.rm-chg-mod');
      const nested = only(item, 'ul');
      const children = [...item.childNodes];
      const wrapped = children.slice(0, children.indexOf(nested)).filter((n): n is HTMLElement => n instanceof HTMLElement);
      assert.deepEqual(
        wrapped.map((n) => n.localName),
        ['del', 'ins'],
        'del then ins, both in front of the nested list',
      );
      assert.equal(wrapped[0].textContent?.trim(), 'The quick brown fox');
      assert.equal(wrapped[1].textContent?.trim(), 'Totally unrelated zebra');
      // What follows the nested list is exactly what the current document has there: a plain text node.
      const after = only(plain, 'li > ul').nextSibling as Node;
      assert.equal(nested.nextSibling?.nodeType, Node.TEXT_NODE);
      assert.equal(nested.nextSibling?.textContent, after.textContent);
      assert.equal(nested.nextSibling, item.lastChild, 'nothing is inserted after the whitespace');
      assert.equal(q(nested, 'ins, del').length, 0);
    });

    it('gutter: a rewritten list item with a nested list is tagged and its nodes are untouched', () => {
      const doc = (first: string) => `- ${first}
  - child one
  - child two
  - child three
`;
      const current = doc('Totally unrelated zebra');
      const plain = document.createElement('div');
      plain.replaceChildren(sanitize(render(current, OPTS).html));
      const { root } = run(doc('The quick brown fox'), current, 'gutter');
      const item = only(root, 'li.rm-chg-mod');
      assert.equal(q(root, 'ins, del').length, 0);
      assert.equal(q(root, CHANGED_SELECTOR).length, 1);
      assert.equal(item.innerHTML, q(plain, 'li')[0].innerHTML);
    });

    it('inline: an emptied table cell keeps its old text as a lone del (no text nodes left to wrap)', () => {
      const doc = (last: string) => `| A | B | C | D |\n|---|---|---|---|\n| alpha one | beta two | gamma three | ${last} |\n`;
      const { root } = run(doc('delta four'), doc(''), 'inline');
      const cell = only(root, 'td.rm-chg-mod');
      assert.equal(cell.children.length, 1);
      assert.equal(only(cell, 'del.rm-del').textContent, 'delta four');
      assert.equal(q(cell, 'ins').length, 0);
      assert.equal(newText(cell), '');
      assert.equal(oldText(cell), 'delta four');
      assert.equal(q(root, CHANGED_SELECTOR).length, 1);
    });

    it('gutter: an emptied table cell is tagged and stays empty', () => {
      const doc = (last: string) => `| A | B | C | D |\n|---|---|---|---|\n| alpha one | beta two | gamma three | ${last} |\n`;
      const { root } = run(doc('delta four'), doc(''), 'gutter');
      const cell = only(root, 'td.rm-chg-mod');
      assert.equal(cell.textContent, '');
      assert.equal(q(root, 'ins, del').length, 0);
    });

    it('inline: a paragraph whose words changed completely is replaced, even when its source stays similar', () => {
      // The block diff compares source text (the shared URL keeps it similar); the word diff compares what is shown.
      const link = (text: string) => `[${text}](https://example.com/some/long/path/here)\n`;
      const { root, ops } = run(link('The quick brown fox'), link('Totally unrelated zebra'), 'inline');
      assert.deepEqual(
        ops.map((o) => o.op),
        ['modify'],
      );
      const removed = only(root, 'p.rm-chg-del');
      const added = only(root, 'p.rm-chg-ins');
      assert.equal(removed.textContent, 'The quick brown fox');
      assert.equal(added.textContent, 'Totally unrelated zebra');
      assert.equal(removed.querySelector('a')?.getAttribute('href'), 'https://example.com/some/long/path/here');
      assert.equal(removed.nextElementSibling, added);
      assert.equal(removed.getAttribute('aria-label'), 'Removed');
      assertStripped(removed);
      assert.equal(q(root, 'ins, del').length, 0);
      assert.equal(q(root, CHANGED_SELECTOR).length, 2);
    });

    it('gutter: the same rewrite is a single modified paragraph', () => {
      const link = (text: string) => `[${text}](https://example.com/some/long/path/here)\n`;
      const { root } = run(link('The quick brown fox'), link('Totally unrelated zebra'), 'gutter');
      const mod = only(root, 'p.rm-chg-mod');
      assert.equal(mod.textContent, 'Totally unrelated zebra');
      assert.equal(q(root, CHANGED_SELECTOR).length, 1);
      assert.equal(q(root, 'p').length, 1);
    });
  });

  describe('list items that differ only in markup or are too many to align', () => {
    for (const mode of ['inline', 'gutter'] as const) {
      it(`flags a task item whose checkbox was ticked: same text, different state (${mode})`, () => {
        const { root } = run('- [ ] write tests\n- [ ] ship it\n', '- [ ] write tests\n- [x] ship it\n', mode);
        const mod = only(root, 'li.rm-chg-mod');
        assert.equal(mod.textContent?.trim(), 'ship it');
        assert.equal(only(mod, 'input').hasAttribute('checked'), true);
        assert.equal(q(root, CHANGED_SELECTOR).length, 1);
        assert.equal(q(root, 'ins, del').length, 0);
      });

      it(`flags a task item whose checkbox was unticked (${mode})`, () => {
        const { root } = run('- [x] write tests\n- [x] ship it\n', '- [x] write tests\n- [ ] ship it\n', mode);
        const mod = only(root, 'li.rm-chg-mod');
        assert.equal(mod.textContent?.trim(), 'ship it');
        assert.equal(only(mod, 'input').hasAttribute('checked'), false);
        assert.equal(q(root, CHANGED_SELECTOR).length, 1);
        assert.equal(q(root, 'ins, del').length, 0);
      });
    }

    // Above 4 million item pairs even the exact alignment gives up (`alignBlocks` returns undefined).
    const COUNT = 2100;
    const items = (word: string) => Array.from({ length: COUNT }, (_, i) => `- item ${i} ${word}\n`).join('');

    it('inline: shows a list too large to align item by item as removed + added', () => {
      const { root, ops } = run(items('alpha'), items('beta'), 'inline');
      assert.deepEqual(
        ops.map((o) => o.op),
        ['modify'],
      );
      const removed = only(root, 'ul.rm-chg-del');
      const added = only(root, 'ul.rm-chg-ins');
      assert.equal(removed.nextElementSibling, added);
      assert.equal(q(removed, 'li').length, COUNT);
      assert.equal(q(added, 'li').length, COUNT);
      assert.equal(removed.querySelector('li')?.textContent, 'item 0 alpha');
      assert.equal(added.querySelector('li')?.textContent, 'item 0 beta');
      assert.equal(removed.getAttribute('aria-label'), 'Removed');
      assertStripped(removed);
      assert.equal(q(root, CHANGED_SELECTOR).length, 2, 'only the two lists are tagged, not every item');
      assert.equal(q(root, 'ins, del').length, 0);
    });

    it('gutter: tags a list too large to align item by item as modified', () => {
      const { root } = run(items('alpha'), items('beta'), 'gutter');
      const mod = only(root, 'ul.rm-chg-mod');
      assert.equal(q(mod, 'li').length, COUNT);
      assert.equal(q(root, CHANGED_SELECTOR).length, 1);
      assert.equal(q(root, REMOVED_SELECTOR).length, 0);
    });
  });

  describe('robustness', () => {
    it('ignores ops that point at lines with no block', () => {
      const html = '<p data-line="0" data-line-end="1">x</p>';
      const root = runOps(html, html, [{ op: 'ins', line: 40 }, { op: 'modify', oldLine: 0, line: 40 }, { op: 'moveTo', oldLine: 0, line: 40, id: 1, edited: false }], 'inline');
      assert.equal(q(root, CHANGED_SELECTOR).length, 0);
    });

    it('sanitizes originalHtml like the document (scripts and handlers in removed blocks are dropped)', () => {
      const original = '<p data-line="0" data-line-end="1" onclick="x()">gone<script>alert(1)</script></p>';
      const root = runOps(original, '<p data-line="0" data-line-end="1">kept</p>', [{ op: 'del', oldLine: 0, before: 0 }], 'inline');
      const clone = only(root, '.rm-chg-del');
      assert.equal(clone.hasAttribute('onclick'), false);
      assert.equal(q(clone, 'script').length, 0);
    });

    it('does not mix up blocks nested in other blocks with top-level ones', () => {
      const { root } = run('> quoted original\n\npara\n', '> quoted original\n\npara\n\nnew para\n', 'inline');
      assert.equal(only(root, '.rm-chg-ins').textContent, 'new para');
    });
  });

  describe('raw HTML blocks', () => {
    const doc = (...blocks: string[]) => ['Intro text here.', ...blocks, 'Outro text here.'].join('\n\n') + '\n';
    const IMG_A = '<img src="images/screenshot-settings-one.png" alt="Screenshot of the settings panel">';
    const IMG_B = '<img src="images/screenshot-settings-two.png" alt="Screenshot of the settings panel">';
    const SVG = (r: string) =>
      `<svg width="10" height="10" viewBox="0 0 10 10">\n<circle cx="5" cy="5" r="${r}"/>\n<text x="1" y="9">chart label text</text>\n</svg>`;

    it('keeps the line attributes and the data-rm-html flag through the sanitizer', () => {
      const { root } = run(doc('<div>a</div>'), doc('<div>a</div>'), 'inline');
      const div = only(root, 'div');
      assert.equal(div.dataset.line, '2');
      assert.equal(div.dataset.lineEnd, '3');
      assert.equal(div.hasAttribute('data-rm-html'), true);
    });

    for (const mode of ['inline', 'gutter'] as const) {
      it(`marks changed text of a <div> (${mode})`, () => {
        const before = '<div>old words here and some more words</div>';
        const after = '<div>new words here and some more words</div>';
        const { root, ops } = run(doc(before), doc(after), mode);
        assert.deepEqual(ops, [{ op: 'modify', oldLine: 2, line: 2 }]);
        const div = only(root, 'div');
        assert.ok(div.classList.contains('rm-chg-mod'));
        assert.equal(q(root, CHANGED_SELECTOR).length, 1);
        if (mode === 'inline') {
          assert.equal(newText(div), 'new words here and some more words');
          assert.equal(oldText(div), 'old words here and some more words');
          assert.ok(q(div, 'ins.rm-ins').length >= 1 && q(div, 'del.rm-del').length >= 1);
        } else {
          assert.equal(div.textContent, 'new words here and some more words');
          assert.equal(q(root, 'ins, del').length, 0);
        }
      });

      it(`tags an added raw <img> block rm-chg-ins (${mode})`, () => {
        const { root, ops } = run(doc(), doc(IMG_A), mode);
        assert.deepEqual(ops, [{ op: 'ins', line: 2 }]);
        const img = only(root, 'img');
        assert.ok(img.classList.contains('rm-chg-ins'));
        assert.equal(img.dataset.line, '2');
        assert.equal(q(root, CHANGED_SELECTOR).length, 1);
      });
    }

    it('shows a removed raw block as a stripped clone (inline)', () => {
      const { root, ops } = run(doc('<div class="note">gone block</div>'), doc(), 'inline');
      assert.deepEqual(ops, [{ op: 'del', oldLine: 2, before: 2 }]);
      const clone = only(root, '.rm-chg-del');
      assert.equal(clone.localName, 'div');
      assert.equal(clone.textContent, 'gone block');
      assertStripped(clone);
      assert.equal(clone.nextElementSibling?.textContent, 'Outro text here.');
      assert.equal(q(root, '[data-line-end]').length, 2, 'only the two paragraphs are live blocks');
    });

    it('marks the block after a removed raw block with data-rm-del-before (gutter)', () => {
      const { root } = run(doc('<div class="note">gone block</div>'), doc(), 'gutter');
      assert.equal(q(root, REMOVED_SELECTOR).length, 0);
      assert.equal(q(root, 'div').length, 0);
      assert.equal(only(root, '[data-rm-del-before]').textContent, 'Outro text here.');
      assert.equal(q(root, CHANGED_SELECTOR).length, 0);
    });

    const opaque = [
      { tag: 'img', before: IMG_A, after: IMG_B },
      { tag: 'svg', before: SVG('3'), after: SVG('5') },
    ];
    for (const c of opaque) {
      it(`inline: shows a changed raw <${c.tag}> as a removed clone and an added element`, () => {
        const { root, ops } = run(doc(c.before), doc(c.after), 'inline');
        assert.deepEqual(ops.map((o) => o.op), ['modify'], 'the host reports a modification');
        const removed = only(root, '.rm-chg-del');
        const added = only(root, '.rm-chg-ins');
        assert.equal(removed.localName, c.tag);
        assert.equal(added.localName, c.tag);
        assert.equal(removed.nextElementSibling, added);
        assert.equal(removed.getAttribute('aria-label'), 'Removed');
        assertStripped(removed);
        assert.equal(added.dataset.line, '2');
        assert.equal(q(root, CHANGED_SELECTOR).length, 2);
        assert.equal(q(root, 'ins, del').length, 0);
      });

      it(`gutter: tags a changed raw <${c.tag}> as modified without a clone`, () => {
        const { root } = run(doc(c.before), doc(c.after), 'gutter');
        const mod = only(root, '.rm-chg-mod');
        assert.equal(mod.localName, c.tag);
        assert.equal(q(root, CHANGED_SELECTOR).length, 1);
        assert.equal(q(root, REMOVED_SELECTOR).length, 0);
      });
    }

    it('leaves a raw block that starts with a comment unmarked (accepted limit)', () => {
      // (One block: the comment ends on its own line only if `-->` is there, so the div shares the line.)
      const { root } = run(doc('<!-- a --><div>old</div>'), doc('<!-- a --><div>new</div>'), 'inline');
      assert.equal(q(root, CHANGED_SELECTOR).length, 0);
      assert.equal(q(root, '[data-rm-html]').length, 0);
    });

    it('marks a raw block that follows a comment block on its own line', () => {
      const { root } = run(doc('<!-- a -->\n<div>old words here and some more words</div>'), doc('<!-- a -->\n<div>new words here and some more words</div>'), 'inline');
      assert.ok(only(root, 'div').classList.contains('rm-chg-mod'));
    });
  });
});
