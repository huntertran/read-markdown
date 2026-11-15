import * as assert from 'node:assert/strict';
import type { BlockMenuContext, ToWebview } from '../../src/protocol';
import { configMessage, rawRenderMessage, renderMessage, usePreview } from './preview';

// The webview entry point (webview/app.ts, started by main.ts) on the real shell, with the real modules:
// messages go in as `message` events, effects are read from the DOM, the posted messages and the state.
// The preview starts once for the whole file, so the tests under 'at start' must run first (mocha runs
// them in order) and every later test sends the config and render it needs.
type Baseline = typeof import('../../webview/baseline');

const REMOVED = '.rm-chg-del, .rm-chg-move-from';

// Track changes: the paragraph at line 2 is edited, '# Removed' and its paragraph are gone, a paragraph
// is added at the end.
const ORIGINAL = '# Intro\n\nIntro text.\n\n# Removed\n\nRemoved text.\n\n# Kept\n\nKept text.\n';
const CURRENT = '# Intro\n\nIntro text, now edited.\n\n# Kept\n\nKept text.\n\nA new paragraph.\n';

describe('webview entry point', () => {
  const preview = usePreview();
  const { vscode, layout } = preview;
  let baseline: Baseline;

  before(async () => {
    baseline = await import('../../webview/baseline');
  });

  const send = (msg: ToWebview) => preview.send(msg);
  const $$ = (selector: string) => [...preview.content.querySelectorAll<HTMLElement>(selector)];
  const one = (selector: string): HTMLElement => {
    const found = $$(selector);
    assert.equal(found.length, 1, `expected one ${selector}, found ${found.length}`);
    return found[0];
  };
  const sectionSlugs = () => $$('section.rm-section').map((s) => s.dataset.slug);
  const marks = () => $$('.rm-chg-ins, .rm-chg-mod, .rm-chg-del, .rm-chg-move-to, .rm-chg-move-from, ins.rm-ins, del.rm-del');
  const changesButton = () => document.getElementById('rm-toggle-changes')!;
  const context = (el: HTMLElement): BlockMenuContext => JSON.parse(el.dataset.vscodeContext ?? 'null') as BlockMenuContext;
  /** Clicks like a user; returns true if the default action was prevented. */
  const click = (el: Element, init: MouseEventInit = {}): boolean =>
    !preview.dispatch(el, new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));

  describe('at start', () => {
    it('posts ready once and saves the state with the document uri', () => {
      assert.deepEqual(preview.postedAtStart, [{ type: 'ready' }]);
      assert.deepEqual(preview.stateAtStart, { uri: 'file:///doc.md' });
    });

    it('drops a render that comes before the first config; the first config does not render it', () => {
      // Baseline 7 travels with the dropped render: it is stored on arrival anyway.
      send(renderMessage(CURRENT, { original: ORIGINAL, baselineId: 7 }));
      assert.equal(preview.content.childNodes.length, 0, 'nothing is rendered without a config');
      assert.equal(document.getElementById('rm-nav-list')!.children.length, 0);
      assert.deepEqual(vscode.posted, []);

      send(configMessage());
      assert.equal(preview.content.childNodes.length, 0, 'the config does not replay the dropped render');
      assert.deepEqual(vscode.posted, []);

      // The first render takes the collapsed sections from the saved state (a reloaded preview).
      vscode.state = { uri: 'file:///doc.md', collapsed: ['kept'] };
      send(renderMessage(CURRENT, { original: ORIGINAL, baselineId: 7, withBaseline: false }));
      assert.deepEqual(sectionSlugs(), ['intro', 'kept']);
      assert.ok(marks().length > 0, 'the baseline of the dropped render is used');
      assert.deepEqual(vscode.posted, [], 'no needBaseline, no second ready');
      assert.equal(one('section[data-slug="kept"]').classList.contains('rm-collapsed'), true);
      assert.equal(one('section[data-slug="intro"]').classList.contains('rm-collapsed'), false);
    });

    it('later renders keep the collapsed sections of the DOM', () => {
      send(renderMessage('# Intro\n\nx\n\n# Kept\n\ny\n', { docVersion: 2 }));
      assert.equal(one('section[data-slug="kept"]').classList.contains('rm-collapsed'), true);
      assert.equal(one('section[data-slug="kept"] > .rm-section-body').getAttribute('hidden'), 'until-found');
      assert.deepEqual(vscode.state?.collapsed, ['kept'], 'and save them');
    });
  });

  describe('render pipeline', () => {
    beforeEach(() => {
      baseline.resetBaseline();
      send(configMessage());
    });

    it('sanitizes the HTML before it reaches the DOM', () => {
      send(
        rawRenderMessage(
          '<p data-line="0" data-line-end="1">ok<img src="x.png" onerror="alert(1)"></p>' +
            '<script>window.pwned = 1</script>' +
            '<div data-line="2" data-line-end="3"><span data-vscode-context=\'{"webviewSection":"rm-block","rmLine":99}\'>x</span>' +
            '<a href="javascript:alert(1)">j</a><iframe src="https://example.com"></iframe></div>',
        ),
      );
      const all = [preview.content, ...$$('*')];
      assert.equal(preview.content.querySelector('script, iframe'), null);
      assert.deepEqual(
        all.flatMap((el) => [...el.attributes].filter((a) => a.name.startsWith('on')).map((a) => a.name)),
        [],
        'no event handler attributes',
      );
      assert.equal(one('span').hasAttribute('data-vscode-context'), false, 'author context is stripped');
      assert.equal(one('a').hasAttribute('href'), false, 'javascript: URL is dropped');
      assert.ok(one('img'), 'allowed content stays');
      assert.equal((window as unknown as { pwned?: number }).pwned, undefined);
    });

    it('stamps each top-level block with its line for the context menu, and rmEditable on <body>', () => {
      send(renderMessage('# T\n\npara\n\n<div>raw</div>\n\n- a\n- b\n'));
      const stamped = $$('[data-vscode-context]');
      assert.deepEqual(
        stamped.map((el) => [el.tagName, context(el)]),
        [
          ['H1', { webviewSection: 'rm-block', rmLine: 0, rmHtml: false }],
          ['P', { webviewSection: 'rm-block', rmLine: 2, rmHtml: false }],
          ['DIV', { webviewSection: 'rm-block', rmLine: 4, rmHtml: true }],
          ['UL', { webviewSection: 'rm-block', rmLine: 6, rmHtml: false }],
        ],
      );
      assert.ok(stamped.every((el) => el.hasAttribute('data-line-end')), 'only top-level blocks');
      assert.deepEqual(JSON.parse(document.body.dataset.vscodeContext!), { rmEditable: false });
      send(configMessage({ editable: true }));
      assert.deepEqual(JSON.parse(document.body.dataset.vscodeContext!), { rmEditable: true });
      send(configMessage());
    });

    it('applies the change marks before it builds the sections', () => {
      send(renderMessage(CURRENT, { original: ORIGINAL }));
      // Marks are found on top-level blocks only, so they exist only if they came before the sections.
      assert.ok(one('[data-line="2"]').querySelector('ins.rm-ins'), 'edited paragraph has word marks');
      assert.equal(one('.rm-chg-ins').textContent, 'A new paragraph.');
      // The removed heading is shown, but does not start a section.
      const removed = one('h1.rm-chg-del');
      assert.equal(removed.textContent, 'Removed');
      assert.equal(removed.id, '');
      assert.equal(removed.classList.contains('rm-heading'), false);
      assert.equal(removed.querySelector('.rm-fold'), null);
      assert.equal(removed.closest<HTMLElement>('section.rm-section')?.dataset.slug, 'intro');
      assert.deepEqual(sectionSlugs(), ['intro', 'kept']);
      assert.equal(document.body.dataset.changes, 'inline');
      assert.equal(changesButton().hidden, false);
      // Removed copies carry no source line, so the context menu cannot target them.
      assert.ok($$(REMOVED).every((el) => !el.hasAttribute('data-vscode-context')));
    });

    it('adds copy buttons to code blocks (not to removed copies); a copy click posts the code', () => {
      send(renderMessage('```js\nlet now = 1;\n```\n', { original: '```js\nlet gone = 1;\n```\n\n```js\nlet now = 1;\n```\n' }));
      assert.equal($$('pre').filter((pre) => pre.closest(REMOVED)).length, 1, 'the removed block is shown');
      const button = one('button.rm-copy');
      assert.equal(button.closest(REMOVED), null);
      click(button);
      assert.deepEqual(vscode.postedOfType('copy'), [{ type: 'copy', text: 'let now = 1;\n' }]);

      send(configMessage({ copyButton: false }));
      assert.equal($$('button.rm-copy').length, 0, 'a copyButton change re-renders without buttons');
    });

    it('applies saved table widths', () => {
      vscode.state = { uri: 'file:///doc.md', tableWidths: [{ key: 'A␟B#0', index: 0, widths: [120, 240] }] };
      send(renderMessage('| A | B |\n|---|---|\n| 1 | 2 |\n'));
      const cols = $$('table > colgroup.rm-colgroup > col');
      assert.deepEqual(
        cols.map((c) => c.style.width),
        ['120px', '240px'],
      );
    });

    it('updates task checkboxes, the task progress bar and the outline counts', () => {
      send(configMessage({ editable: true }));
      send(renderMessage('# Plan\n\n- [x] one\n- [/] two\n- [ ] three\n'));
      const boxes = $$('input.task-list-item-checkbox') as HTMLInputElement[];
      assert.deepEqual(
        boxes.map((b) => b.disabled),
        [false, false, false],
        'enabled in edit mode',
      );
      const bar = document.getElementById('rm-task-progress')!;
      assert.equal(bar.hidden, false);
      assert.equal(bar.getAttribute('aria-valuetext'), '1 of 3 done · 1 in progress');
      assert.equal(document.querySelector('#rm-nav-list .rm-nav-tasks')?.textContent, '1/3');

      send(configMessage());
      assert.deepEqual(
        boxes.map((b) => b.disabled),
        [true, true, true],
        'disabled again when editing is off',
      );
    });

    it('follows a step that starts in progress after restoring the scroll position', () => {
      // The items are created by the render itself, so they get their place from the prototype: an
      // in-progress item far below the viewport, everything else at the top.
      const proto = window.HTMLElement.prototype;
      const saved = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
      const rect = (top: number) => ({ top, bottom: top + 20, left: 0, right: 0, x: 0, y: top, width: 0, height: 20, toJSON: () => ({}) });
      Object.defineProperty(proto, 'getBoundingClientRect', {
        configurable: true,
        value(this: HTMLElement) {
          return rect(this.matches('li[data-task="active"]') ? 2_000 - layout.scrollY : -layout.scrollY);
        },
      });
      try {
        send(renderMessage('- [ ] one\n- [ ] two\n'));
        layout.scrollY = 50;
        layout.advance(10_000); // the reader has been idle: following may scroll
        send(renderMessage('- [/] one\n- [ ] two\n', { docVersion: 2 }));
        // The restore (to 50) comes first; the follow scroll (item a third down the viewport) is the last word.
        assert.deepEqual(
          layout.scrolls.map((s) => Math.round(s.top)),
          [0, 50, Math.round(2_000 - 800 / 3)],
        );
      } finally {
        if (saved) Object.defineProperty(proto, 'getBoundingClientRect', saved);
        else delete (proto as unknown as Record<string, unknown>).getBoundingClientRect;
      }
    });

    it('drops the list grip of the replaced content', () => {
      send(configMessage({ editable: true }));
      send(renderMessage('- one\n- two\n'));
      preview.dispatch($$('li')[0], new window.MouseEvent('mousemove', { bubbles: true }));
      preview.frames.run();
      const grip = document.querySelector<HTMLElement>('.rm-item-grip')!;
      assert.equal(grip.hidden, false);
      send(renderMessage('- one\n- two\n- three\n', { docVersion: 2 }));
      assert.equal(grip.hidden, true);
      send(configMessage());
    });

    it('fills the outline up to navMaxDepth and re-renders when it changes', () => {
      send(renderMessage('# One\n\n## Two\n\n### Three\n'));
      const outline = () => [...document.querySelectorAll<HTMLElement>('#rm-nav-list > li')].map((li) => li.dataset.slug);
      assert.deepEqual(outline(), ['one', 'two', 'three']);
      send(configMessage({ navMaxDepth: 2 }));
      assert.deepEqual(outline(), ['one', 'two']);
      send(configMessage({ collapsible: false }));
      assert.deepEqual(sectionSlugs(), [], 'collapsible off re-renders without sections');
      send(configMessage());
    });

    it('re-applies the active search to the new content', () => {
      send(renderMessage('needle one\n\nhay\n'));
      send({ type: 'highlight', term: 'needle', caseSensitive: false, blockLine: 0, occurrence: 0 });
      assert.equal(preview.highlights.get('rm-search-current')?.ranges.length, 1);
      send(renderMessage('hay\n\nneedle two\n\nneedle three\n', { docVersion: 2 }));
      const ranges = [...preview.highlights.get('rm-search')!.ranges, ...preview.highlights.get('rm-search-current')!.ranges];
      assert.equal(ranges.length, 2);
      assert.ok(
        ranges.every((r) => r.startContainer.isConnected && preview.content.contains(r.startContainer)),
        'ranges point into the new content',
      );
      assert.equal(document.getElementById('rm-search-badge')!.hidden, false);
      send({ type: 'highlight', term: '', caseSensitive: false, blockLine: 0, occurrence: 0 });
      assert.equal(preview.highlights.size, 0);
    });
  });

  describe('track changes baseline', () => {
    beforeEach(() => {
      baseline.resetBaseline();
      send(configMessage());
    });

    it('asks once per id for a baseline it does not hold, and renders without marks meanwhile', () => {
      send(renderMessage(CURRENT, { original: ORIGINAL, baselineId: 5, withBaseline: false }));
      assert.deepEqual(vscode.postedOfType('needBaseline'), [{ type: 'needBaseline', id: 5 }]);
      assert.deepEqual(marks(), []);
      assert.equal(document.body.dataset.changes, '');
      assert.equal(changesButton().hidden, true);
      assert.ok($$('[data-line="2"]').length, 'the current content is shown');

      send(renderMessage(CURRENT, { original: ORIGINAL, baselineId: 5, withBaseline: false, docVersion: 2 }));
      assert.equal(vscode.postedOfType('needBaseline').length, 1, 'not asked again for the same id');

      send(renderMessage(CURRENT, { original: ORIGINAL, baselineId: 6, withBaseline: false, docVersion: 3 }));
      assert.deepEqual(vscode.postedOfType('needBaseline'), [
        { type: 'needBaseline', id: 5 },
        { type: 'needBaseline', id: 6 },
      ]);

      send(renderMessage(CURRENT, { original: ORIGINAL, baselineId: 6, docVersion: 3 }));
      assert.ok(marks().length > 0, 'the re-sent render with the HTML has marks');
      assert.equal(vscode.postedOfType('needBaseline').length, 2);
    });

    it('keeps the baseline for later renders citing its id, and releases it on a render without changes', () => {
      send(renderMessage(CURRENT, { original: ORIGINAL, baselineId: 3 }));
      assert.ok(marks().length > 0);
      send(renderMessage(`${CURRENT}\nOne more.\n`, { original: ORIGINAL, baselineId: 3, withBaseline: false, docVersion: 2 }));
      assert.ok(marks().length > 0, 'id-only render is marked from the stored baseline');
      assert.deepEqual(vscode.postedOfType('needBaseline'), []);

      send(renderMessage(CURRENT, { docVersion: 3 }));
      assert.deepEqual(marks(), []);
      assert.equal(document.body.dataset.changes, '');
      send(renderMessage(CURRENT, { original: ORIGINAL, baselineId: 3, withBaseline: false, docVersion: 4 }));
      assert.deepEqual(vscode.postedOfType('needBaseline'), [{ type: 'needBaseline', id: 3 }], 'released');
    });

    it('shows no marks and asks for nothing while changes are off', () => {
      send(configMessage({ changesMode: 'off' }));
      send(renderMessage(CURRENT, { original: ORIGINAL, baselineId: 4, withBaseline: false }));
      send(renderMessage(CURRENT, { original: ORIGINAL, baselineId: 4, docVersion: 2 }));
      assert.deepEqual(marks(), []);
      assert.deepEqual(vscode.postedOfType('needBaseline'), []);
      assert.equal(changesButton().hidden, true);
    });
  });

  describe('block editor', () => {
    const DOC = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n';

    beforeEach(() => {
      baseline.resetBaseline();
      send(configMessage({ editable: true }));
      send(renderMessage(DOC));
    });

    afterEach(() => {
      send(configMessage()); // editing off closes an editor left open
    });

    /** Opens the paragraph at line 2 through the context menu message and the host's reply. */
    function openEditor(): HTMLTextAreaElement {
      const end = Number(one('[data-line="2"]').dataset.lineEnd);
      send({ type: 'startEdit', line: 2 });
      assert.deepEqual(vscode.postedOfType('requestBlockSource'), [{ type: 'requestBlockSource', start: 2, end, docVersion: 1 }]);
      send({ type: 'blockSource', start: 2, end, docVersion: 1, text: 'First paragraph.' });
      return one('textarea.rm-edit-input') as HTMLTextAreaElement;
    }

    it('holds renders back while a block is open; the baseline of a held render is kept', () => {
      openEditor();
      // Both held back; the second replaces the first and cites its baseline without the HTML.
      send(renderMessage(`${DOC}\nThird.\n`, { docVersion: 2, original: DOC, baselineId: 9 }));
      send(renderMessage(`${DOC}\nThird, edited.\n`, { docVersion: 3, original: DOC, baselineId: 9, withBaseline: false }));
      assert.ok(one('textarea.rm-edit-input'), 'the editor is still open');
      assert.equal(preview.content.textContent?.includes('Third'), false);

      click(one('button.rm-edit-cancel'));
      assert.equal($$('textarea').length, 0);
      assert.equal(one('.rm-chg-ins').textContent, 'Third, edited.', 'the newest held render, with marks');
      assert.deepEqual(vscode.postedOfType('needBaseline'), []);
    });

    it('routes editResult to the open editor', () => {
      const textarea = openEditor();
      textarea.value = 'First paragraph, changed.';
      click(one('button.rm-edit-save'));
      const sent = vscode.postedOfType('editBlock');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].text, 'First paragraph, changed.');

      send({ type: 'editResult', start: sent[0].start, end: sent[0].end, ok: false, error: 'readonly' });
      assert.equal(one('.rm-edit-notice').textContent, 'This document is read-only.');

      click(one('button.rm-edit-save'));
      send({ type: 'editResult', start: sent[0].start, end: sent[0].end, ok: true });
      assert.equal($$('textarea').length, 0, 'closed on success');
      assert.equal(one('[data-line="2"]').textContent, 'First paragraph.');
    });
  });

  describe('link clicks', () => {
    beforeEach(() => {
      send(configMessage());
    });

    it('posts openLink with data-href, preferred over href, and prevents navigation', () => {
      send(rawRenderMessage('<p data-line="0" data-line-end="1"><a href="https://example.com/x" data-href="./other.md">l</a></p>'));
      assert.equal(click(one('a')), true);
      assert.deepEqual(vscode.posted, [{ type: 'openLink', href: './other.md' }]);
    });

    it('posts the original target of a rendered link, and the href of a link without data-href', () => {
      send(renderMessage('[o](other.md#part) and <a href="https://example.com/">raw</a>\n'));
      const [md, raw] = $$('a');
      assert.equal(click(md), true);
      assert.equal(click(raw), true);
      assert.deepEqual(vscode.postedOfType('openLink'), [
        { type: 'openLink', href: 'other.md#part' },
        { type: 'openLink', href: 'https://example.com/' },
      ]);
    });

    it('reveals a #fragment target locally: expands its section, scrolls to it, posts nothing', () => {
      send(renderMessage('[go](#target) [c](#caf%C3%A9)\n\n# Outer\n\n## Target\n\ntext\n\n# Café\n\nmore\n'));
      for (const fold of $$('section[data-level="1"] > .rm-heading > .rm-fold')) click(fold);
      assert.deepEqual(vscode.state?.collapsed, ['outer', 'café']);
      vscode.clear();
      const [go, cafe] = $$('a');
      layout.scrollY = 100;
      layout.place(one('#target'), 500);
      layout.place(one('#café'), 900);

      assert.equal(click(go), true, 'navigation prevented');
      assert.deepEqual(vscode.posted, []);
      assert.equal(one('section[data-slug="outer"]').classList.contains('rm-collapsed'), false, 'the enclosing section is expanded');
      assert.deepEqual(layout.scrolls.at(-1), { top: 492, behavior: 'instant' });
      assert.deepEqual(vscode.state?.collapsed, ['café']);

      // The slug is percent-decoded. A heading stays visible in its own collapsed section, which stays collapsed.
      assert.equal(click(cafe), true);
      assert.deepEqual(layout.scrolls.at(-1), { top: 892, behavior: 'instant' });
      assert.deepEqual(vscode.state?.collapsed, ['café']);
      assert.deepEqual(vscode.posted, []);
    });

    it('ignores clicks outside links and on links without a target', () => {
      send(rawRenderMessage('<p data-line="0" data-line-end="1">text <a name="anchor">anchor</a></p>'));
      assert.equal(click(one('p')), false);
      assert.equal(click(one('a')), false);
      assert.deepEqual(vscode.posted, []);
    });

    it('toggles a section from its fold button and saves the collapsed slugs', () => {
      send(renderMessage('# A\n\na\n\n# B\n\nb\n'));
      assert.equal(click(one('section[data-slug="a"] > .rm-heading > .rm-fold')), true);
      assert.deepEqual(vscode.state?.collapsed, ['a']);
      assert.equal(document.getElementById('rm-fold-all')!.dataset.mode, 'collapse');
      click(one('section[data-slug="b"] > .rm-heading > .rm-fold'));
      assert.equal(document.getElementById('rm-fold-all')!.dataset.mode, 'expand', 'fold-all button follows');
      click(document.getElementById('rm-fold-all')!);
      assert.deepEqual(vscode.state?.collapsed, []);
    });
  });

  describe('changes view toggle', () => {
    beforeEach(() => {
      baseline.resetBaseline();
      send(configMessage({ changesMode: 'inline' }));
    });

    it('flips inline and gutter for this preview, persists it and re-renders', () => {
      send(renderMessage(CURRENT, { original: ORIGINAL }));
      assert.equal(document.body.dataset.changes, 'inline');
      assert.ok($$(REMOVED).length > 0, 'inline shows removed blocks');
      assert.equal(changesButton().getAttribute('aria-pressed'), 'true');

      send({ type: 'toggleChanges' });
      assert.equal(vscode.state?.changesMode, 'gutter');
      assert.equal(document.body.dataset.changes, 'gutter');
      assert.deepEqual($$(REMOVED), [], 're-rendered as bars only');
      assert.ok($$('.rm-chg-mod, .rm-chg-ins').length > 0);
      assert.equal(changesButton().getAttribute('aria-pressed'), 'false');
      assert.equal(changesButton().title, 'Show changes inline');

      click(changesButton());
      assert.equal(vscode.state?.changesMode, 'inline', 'the toolbar button does the same');
      assert.ok($$(REMOVED).length > 0);
      assert.deepEqual(vscode.postedOfType('needBaseline'), []);
    });

    it('a saved override wins over the setting until the setting changes', () => {
      vscode.state = { uri: 'file:///doc.md', changesMode: 'gutter' };
      send(renderMessage(CURRENT, { original: ORIGINAL }));
      assert.equal(document.body.dataset.changes, 'gutter');

      send(configMessage({ changesMode: 'inline' }));
      assert.equal(vscode.state?.changesMode, 'gutter', 'same setting value: the override stays');
      send(configMessage({ changesMode: 'gutter' }));
      assert.equal(vscode.state?.changesMode, undefined, 'a new setting value drops the override');
      send(renderMessage(CURRENT, { original: ORIGINAL, docVersion: 2 }));
      assert.equal(document.body.dataset.changes, 'gutter');
      send({ type: 'toggleChanges' });
      assert.equal(document.body.dataset.changes, 'inline');
      send(configMessage({ changesMode: 'inline' }));
    });

    it('does nothing while changes are off', () => {
      send(configMessage({ changesMode: 'off' }));
      send(renderMessage(CURRENT, { original: ORIGINAL }));
      send({ type: 'toggleChanges' });
      assert.equal(vscode.state?.changesMode, undefined);
      assert.deepEqual(marks(), []);
      send(configMessage({ changesMode: 'inline' }));
    });
  });

  describe('routes every host message', () => {
    beforeEach(() => {
      baseline.resetBaseline();
      send(configMessage());
    });

    // Keyed by message type, so a new `ToWebview` type does not compile until it has a case here.
    const cases: { [K in ToWebview['type']]: () => void } = {
      config: () => {
        send(configMessage({ preset: 'sepia', navPosition: 'right', navShow: false, scheme: 'dark', headingHighlight: 'underline' }, ':root { --rm-x: 2; }'));
        assert.equal(document.getElementById('rm-vars')!.textContent, ':root { --rm-x: 2; }');
        assert.equal(document.body.dataset.preset, 'sepia');
        assert.equal(document.body.dataset.navPosition, 'right');
        assert.equal(document.body.dataset.headingHighlight, 'underline');
        assert.equal(document.body.dataset.scheme, 'dark');
        assert.equal(document.body.classList.contains('rm-nav-visible'), false);
        send(configMessage());
        assert.equal(document.body.dataset.scheme, 'light');
        assert.equal(document.body.classList.contains('rm-nav-visible'), true);
      },
      render: () => {
        send(renderMessage('# Hello\n\nworld\n'));
        assert.equal(one('h1').textContent, 'Hello');
        assert.equal(document.querySelector('#rm-nav-list a')?.textContent, 'Hello');
      },
      highlight: () => {
        send(renderMessage('find me\n'));
        send({ type: 'highlight', term: 'find', caseSensitive: false, blockLine: 0, occurrence: 0 });
        assert.equal(preview.highlights.get('rm-search-current')?.ranges[0].toString(), 'find');
        send({ type: 'highlight', term: '', caseSensitive: false, blockLine: 0, occurrence: 0 });
      },
      scrollToLine: () => {
        send(renderMessage('a\n\nb\n\nc\n'));
        layout.place(one('[data-line="0"]'), 0);
        layout.place(one('[data-line="2"]'), 300);
        layout.place(one('[data-line="4"]'), 600);
        send({ type: 'scrollToLine', line: 4 });
        assert.deepEqual(layout.scrolls.at(-1), { top: 600, behavior: 'instant' });
      },
      revealHeading: () => {
        send(renderMessage('# A\n\na\n\n## Inner\n\ni\n'));
        click(one('section[data-slug="a"] > .rm-heading > .rm-fold'));
        layout.place(one('#inner'), 250);
        send({ type: 'revealHeading', slug: 'inner' });
        assert.equal(one('section[data-slug="a"]').classList.contains('rm-collapsed'), false, 'parent section expanded');
        assert.deepEqual(layout.scrolls.at(-1), { top: 242, behavior: 'instant' });
        assert.deepEqual(vscode.state?.collapsed, []);
      },
      blockSource: () => {
        send(configMessage({ editable: true }));
        send(renderMessage('para\n'));
        send({ type: 'startEdit', line: 0 });
        send({ type: 'blockSource', start: 0, end: 1, docVersion: 1, text: 'para' });
        assert.equal((one('textarea.rm-edit-input') as HTMLTextAreaElement).value, 'para');
        click(one('button.rm-edit-cancel'));
        send(configMessage());
      },
      startEdit: () => {
        send(configMessage({ editable: true }));
        send(renderMessage('# T\n\npara\n'));
        send({ type: 'startEdit', line: 2 });
        assert.deepEqual(vscode.postedOfType('requestBlockSource'), [{ type: 'requestBlockSource', start: 2, end: 3, docVersion: 1 }]);
        send(configMessage());
      },
      editResult: () => {
        send(configMessage({ editable: true }));
        send(renderMessage('para\n'));
        send({ type: 'startEdit', line: 0 });
        send({ type: 'blockSource', start: 0, end: 1, docVersion: 1, text: 'para' });
        (one('textarea.rm-edit-input') as HTMLTextAreaElement).value = 'para 2';
        click(one('button.rm-edit-save'));
        send({ type: 'editResult', start: 0, end: 1, ok: false, error: 'stale' });
        assert.match(one('.rm-edit-notice').textContent ?? '', /^The file changed/);
        send(configMessage());
      },
      taskResult: () => {
        send(configMessage({ editable: true }));
        send(renderMessage('- [ ] one\n- [ ] two\n'));
        const box = $$('input.task-list-item-checkbox')[1] as HTMLInputElement;
        box.click();
        assert.deepEqual(vscode.postedOfType('toggleTask'), [{ type: 'toggleTask', line: 1, checked: true, docVersion: 1 }]);
        send({ type: 'taskResult', line: 1, ok: false, error: 'readonly' });
        assert.equal(box.checked, false, 'put back');
        assert.equal(one('.rm-edit-flash').textContent, 'This document is read-only.');
        send(configMessage());
      },
      moveResult: () => {
        send(configMessage({ editable: true }));
        send(renderMessage('- one\n- two\n- three\n'));
        const items = () => $$('li').map((li) => li.textContent);
        const [first] = $$('li');
        preview.dispatch(first, new window.MouseEvent('mousemove', { bubbles: true, clientY: 5 }));
        preview.frames.run();
        const grip = document.querySelector<HTMLElement>('.rm-item-grip')!;
        assert.equal(grip.hidden, false, 'grip shown on the hovered item');
        preview.dispatch(grip, new window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
        assert.deepEqual(items(), ['two', 'one', 'three'], 'moved in the DOM first');
        assert.equal(vscode.postedOfType('moveListItem').length, 1);
        send({ type: 'moveResult', ok: false, error: 'stale' });
        assert.deepEqual(items(), ['one', 'two', 'three'], 'put back after a failed move');
        assert.equal(one('.rm-edit-flash').textContent, 'The file changed before the move was saved, so the list was put back.');
        send(configMessage());
      },
      toggleChanges: () => {
        send(renderMessage(CURRENT, { original: ORIGINAL }));
        send({ type: 'toggleChanges' });
        assert.equal(document.body.dataset.changes, 'gutter');
      },
    };

    for (const [type, run] of Object.entries(cases)) it(type, run);
  });

  describe('toolbar and scrolling', () => {
    beforeEach(() => {
      send(configMessage());
    });

    it('posts the outline toggle as a setting on a wide preview', () => {
      click(document.getElementById('rm-toggle-nav')!);
      assert.deepEqual(vscode.posted, [{ type: 'updateSetting', key: 'nav.show', value: false }]);
    });

    it('reports a scroll that follows user input to the editor as revealLine', () => {
      send(renderMessage('a\n\nb\n\nc\n'));
      layout.place(one('[data-line="0"]'), 0);
      layout.place(one('[data-line="2"]'), 300);
      layout.place(one('[data-line="4"]'), 600);
      layout.advance(1_000); // the programmatic scroll of the render is long over
      preview.dispatch(window, new window.Event('wheel'));
      layout.scrollY = 300;
      preview.dispatch(window, new window.Event('scroll'));
      preview.frames.run();
      assert.deepEqual(vscode.postedOfType('revealLine'), [{ type: 'revealLine', line: 2 }]);
    });
  });
});
