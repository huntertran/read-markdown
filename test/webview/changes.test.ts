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
});
