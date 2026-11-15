import * as assert from 'node:assert/strict';
import { createMarkdownRenderer } from '../../src/render/markdown';
import type { SectionOptions } from '../../webview/sections';
import type { TaskCounts, TaskUpdateOptions } from '../../webview/taskProgress';
import { useDom } from './dom';
import { useLayout } from './layout';
import { useVsCodeApi } from './vscodeApi';

// taskProgress.ts pulls in api.ts (acquireVsCodeApi at import), sections.ts, changes.ts and
// scroll.ts (window listeners at import), so everything is loaded after the DOM and the stubs exist.
// The module keeps the previous render's task states in module state; every test starts by turning
// the feature off through its public API, which forgets them.
type TaskProgress = typeof import('../../webview/taskProgress');
type Scroll = typeof import('../../webview/scroll');
type Sections = typeof import('../../webview/sections');
type Sanitize = typeof import('../../webview/sanitize');

const FAR = 2_000; // absolute top far below the viewport (innerHeight 800)
const NEAR = 300; // inside the viewport
const JUST_DONE = 'rm-task-just-done';

describe('task progress', () => {
  useDom();
  const vscode = useVsCodeApi();
  const layout = useLayout();

  const render = createMarkdownRenderer();
  let tp: TaskProgress;
  let scroll: Scroll;
  let sections: Sections;
  let sanitize: Sanitize['sanitize'];
  let content: HTMLElement;
  let bar: HTMLElement;
  let followButton: HTMLButtonElement;
  let invalidations = 0;

  before(async () => {
    tp = await import('../../webview/taskProgress');
    scroll = await import('../../webview/scroll');
    sections = await import('../../webview/sections');
    ({ sanitize } = await import('../../webview/sanitize'));
    scroll.onInvalidate(() => invalidations++);
  });

  beforeEach(() => {
    layout.advance(1_000_000); // the reader has been idle for a long time (FOLLOW_IDLE_MS is 2000)
    window.dispatchEvent(new window.Event('blur')); // no pointer held by an earlier test
    content = document.createElement('div');
    bar = document.createElement('div');
    followButton = document.createElement('button');
    document.body.append(content, bar, followButton);
    tp.initTaskProgress({ content, bar, followButton });
    tp.updateTaskProgress({ enabled: false, progress: false, busy: false }); // forget the previous states
    invalidations = 0;
  });

  // ---- helpers ------------------------------------------------------------------------------

  /** Text of the item's own line (what the module keys on), for choosing a position and for assertions. */
  const textOf = (li: Element): string => (li.querySelector(':scope > label, :scope > p:first-child') ?? li).textContent.replace(/\s+/g, ' ').trim();
  const itemEls = (): HTMLElement[] => [...content.querySelectorAll<HTMLElement>('li.task-list-item')];

  interface LoadOptions {
    /** Absolute top per item text; items not listed are at NEAR. */
    tops?: Record<string, number>;
    sections?: Partial<SectionOptions>;
  }

  /** Renders `markdown` the way main.ts does: real renderer, sanitize, sections; then places the items. */
  function load(markdown: string, options: LoadOptions = {}): void {
    content.replaceChildren(sanitize(render(markdown, { mermaid: true }).html));
    sections.buildSections(content, { collapsible: true, startCollapsedBelowLevel: 0, collapsed: undefined, ...options.sections });
    place(options.tops);
  }

  function place(tops: Record<string, number> = {}): void {
    for (const li of itemEls()) layout.place(li, tops[textOf(li)] ?? NEAR);
  }

  function update(options: Partial<TaskUpdateOptions> = {}): Map<string, TaskCounts> | undefined {
    return tp.updateTaskProgress({ enabled: true, progress: true, busy: false, ...options });
  }

  /** Texts of the items carrying the "just done" flash. */
  const flashed = (): string[] => itemEls().filter((li) => li.classList.contains(JUST_DONE)).map(textOf);
  const scrolls = () => layout.scrolls;
  const counts = (map: Map<string, TaskCounts> | undefined): Record<string, TaskCounts> | undefined => (map ? Object.fromEntries(map) : undefined);
  /** The scroll a started item at `top` is revealed with (scrollY 0): a third of the viewport from the top. */
  const revealTop = (top: number): number => top - 800 / 3;

  /**
   * A step starts: render 1 has `a` done and `b`, `c` open; render 2 has `b` in progress, far below
   * the viewport. Returns after the second update.
   */
  function startStep(options: { follow?: boolean; busy?: boolean; enabled?: boolean } = {}): void {
    vscode.state = { uri: '', followTasks: options.follow ?? true };
    load('- [x] a\n- [ ] b\n- [ ] c\n');
    update();
    load('- [x] a\n- [/] b\n- [ ] c\n', { tops: { b: FAR } });
    update({ busy: options.busy ?? false, enabled: options.enabled ?? true });
  }

  // ---- just done flash -------------------------------------------------------------------------

  describe('"just done" flash', () => {
    it('flags an item that was in progress and is checked in the next render', () => {
      load('- [/] a\n- [ ] b\n');
      update();
      load('- [x] a\n- [ ] b\n');
      update();
      assert.deepEqual(flashed(), ['a']);
    });

    it('not on the first render, even for an item that is already done', () => {
      load('- [x] a\n- [/] b\n- [ ] c\n');
      update();
      assert.deepEqual(flashed(), []);
    });

    it('not for an item that was only open, only in progress, or already done', () => {
      load('- [ ] todo\n- [/] busy\n- [x] done\n- [/] still\n');
      update();
      load('- [x] todo\n- [/] busy\n- [x] done\n- [/] still\n');
      update();
      assert.deepEqual(flashed(), [], 'open -> done is not a finished step in progress');
      load('- [x] todo\n- [ ] busy\n- [x] done\n- [/] still\n');
      update();
      assert.deepEqual(flashed(), [], 'in progress -> open is not done');
    });

    it('not for an item that is new in the render', () => {
      load('- [ ] a\n');
      update();
      load('- [ ] a\n- [x] brand new\n');
      update();
      assert.deepEqual(flashed(), []);
    });

    it('only once: the render after the flash does not flag it again', () => {
      load('- [/] a\n');
      update();
      load('- [x] a\n');
      update();
      assert.deepEqual(flashed(), ['a']);
      load('- [x] a\n');
      update();
      assert.deepEqual(flashed(), []);
    });

    it('works for loose list items (the checkbox is inside a paragraph)', () => {
      load('- [/] a\n\n- [ ] b\n');
      update();
      load('- [x] a\n\n- [ ] b\n');
      update();
      assert.deepEqual(flashed(), ['a']);
    });

    it('flags nested items on their own, not their parents', () => {
      load('- [/] parent\n  - [/] child\n');
      update();
      load('- [/] parent\n  - [x] child\n');
      update();
      assert.deepEqual(flashed(), ['child']);
    });

    it('is removed when the animation ends, and only for that animation', () => {
      load('- [/] a\n');
      update();
      load('- [x] a\n');
      update();
      const li = itemEls()[0];
      const checkbox = li.querySelector('input')!;
      const end = (name: string) => checkbox.dispatchEvent(Object.assign(new window.Event('animationend', { bubbles: true }), { animationName: name }));
      end('something-else');
      assert.ok(li.classList.contains(JUST_DONE));
      end('rm-task-just-done');
      assert.equal(li.classList.contains(JUST_DONE), false);
    });

    it('flashes nothing when the feature is off', () => {
      load('- [/] a\n');
      update();
      load('- [x] a\n');
      update({ enabled: false });
      assert.deepEqual(flashed(), []);
    });

    it('flashes also when the progress display is off', () => {
      load('- [/] a\n');
      update({ progress: false });
      load('- [x] a\n');
      update({ progress: false });
      assert.deepEqual(flashed(), ['a']);
    });
  });

  // ---- keys -----------------------------------------------------------------------------------

  describe('item identity: text plus occurrence', () => {
    it('tracks two items with the same text separately', () => {
      load('- [/] same\n- [/] same\n');
      update();
      load('- [/] same\n- [x] same\n');
      update();
      assert.deepEqual(
        itemEls().map((li) => li.classList.contains(JUST_DONE)),
        [false, true],
      );
    });

    it('matches duplicates by order: the first occurrence is the first occurrence', () => {
      load('- [x] same\n- [/] same\n');
      update();
      load('- [x] same\n- [x] same\n');
      update();
      assert.deepEqual(
        itemEls().map((li) => li.classList.contains(JUST_DONE)),
        [false, true],
      );
    });

    // Regression tests: `itemText` once returned '' for every item (its `closest('ul, ol')` found the
    // list the item itself is in), so items were keyed by position only.

    // Reproduction: render `- [/] write the tests`, then `- [x] write all the tests`: the second
    // render flashes the reworded item (expected: nothing, it is a new item).
    it('a reworded item has nothing to compare against', () => {
      load('- [/] write the tests\n');
      update();
      load('- [x] write all the tests\n');
      update();
      assert.deepEqual(flashed(), []);
    });

    // Reproduction: render `- [ ] y` / `- [/] z`, then `- [x] z` / `- [ ] y`: nothing flashes
    // (expected: z, which was in progress and is now done, wherever it moved to).
    it('an item that moved and finished flashes, wherever it is', () => {
      load('- [ ] y\n- [/] z\n');
      update();
      load('- [x] z\n- [ ] y\n');
      update();
      assert.deepEqual(flashed(), ['z']);
    });

    // Reproduction: render `- [x] x` / `- [ ] y` / `- [/] z`, then move z to the top: z is taken for
    // the item that was at position 1 (done), so the follow scrolls to a step that has not started.
    it('reordering does not produce a false follow or flash', () => {
      vscode.state = { uri: '', followTasks: true };
      load('- [x] x\n- [ ] y\n- [/] z\n');
      update();
      load('- [/] z\n- [x] x\n- [ ] y\n', { tops: { z: FAR } });
      update();
      assert.deepEqual(flashed(), []);
      assert.deepEqual(scrolls(), []);
    });

    // Reproduction: render `- [/] a` / `- [ ] b`, then insert a new first item and finish a:
    // `- [ ] new` / `- [x] a` / `- [ ] b`. Expected: a flashes.
    it('an item inserted above does not shift the tracking of the others', () => {
      load('- [/] a\n- [ ] b\n');
      update();
      load('- [ ] new\n- [x] a\n- [ ] b\n');
      update();
      assert.deepEqual(flashed(), ['a']);
    });

    // Reproduction: `- [ ] intro` / `- [/] some   step`, then `- [x] some step` / `- [ ] intro`.
    it('ignores whitespace differences in the text', () => {
      load('- [ ] intro\n- [/] some   step\n');
      update();
      load('- [x] some step\n- [ ] intro\n');
      update();
      assert.deepEqual(flashed(), ['some step']);
    });

    it('ignores words struck out by inline track changes', () => {
      load('- [ ] intro\n- [/] fix bug\n');
      update();
      load('- [x] fix bug\n- [ ] intro\n');
      const label = content.querySelector('label')!;
      label.insertBefore(Object.assign(document.createElement('del'), { className: 'rm-del', textContent: 'old ' }), label.lastChild);
      assert.equal(label.textContent.replace(/\s+/g, ' ').trim(), 'old fix bug');
      update();
      assert.equal(itemEls()[0].classList.contains(JUST_DONE), true, 'the struck-out word does not change the key (still the same step)');
    });

    it('the text of nested lists is not part of the parent key', () => {
      load('- [ ] intro\n- [/] parent\n  - [ ] child one\n');
      update();
      load('- [x] parent\n  - [ ] a different child\n- [ ] intro\n');
      update();
      assert.deepEqual(flashed(), ['parent']);
    });
  });

  // ---- removed clones ---------------------------------------------------------------------------

  describe('removed blocks (track changes clones)', () => {
    /** An item as `cloneRemoved` leaves it: inside a `.rm-chg-del` block, `data-task` kept. */
    function addClone(text: string, state: 'todo' | 'active' | 'done', options: { before?: Element; top?: number } = {}): HTMLElement {
      const wrapper = document.createElement('div');
      wrapper.className = 'rm-chg-del';
      wrapper.innerHTML =
        `<ul class="contains-task-list"><li class="task-list-item"${state === 'active' ? ' data-task="active"' : ''}>` +
        `<label><input class="task-list-item-checkbox" type="checkbox" disabled${state === 'done' ? ' checked' : ''}> ${text}</label></li></ul>`;
      if (options.before) options.before.before(wrapper);
      else content.append(wrapper);
      const li = wrapper.querySelector('li')!;
      layout.place(li, options.top ?? NEAR);
      return li;
    }

    it('are not counted', () => {
      load('- [x] real\n');
      addClone('ghost', 'active');
      addClone('ghost 2', 'todo');
      update();
      assert.equal(bar.getAttribute('aria-valuemax'), '1');
      assert.equal(bar.getAttribute('aria-valuenow'), '1');
      assert.equal(followButton.hidden, true, 'the only item in progress is a removed clone');
    });

    it('are not tracked: a clone does not take the occurrence of a real item with the same text', () => {
      load('- [/] same\n');
      addClone('same', 'todo', { before: content.firstElementChild! });
      update();
      load('- [x] same\n');
      addClone('same', 'todo', { before: content.firstElementChild! });
      update();
      assert.deepEqual(
        itemEls()
          .filter((li) => !li.closest('.rm-chg-del'))
          .map((li) => li.classList.contains(JUST_DONE)),
        [true],
      );
    });

    it('never flash, and never start a follow', () => {
      load('- [ ] real\n');
      update();
      load('- [ ] real\n');
      addClone('ghost', 'active', { top: FAR });
      update();
      assert.deepEqual(scrolls(), []);
      load('- [ ] real\n');
      addClone('ghost', 'done');
      update();
      assert.deepEqual(flashed(), []);
    });

    it('are left out of the heading counts, and a removed heading starts no group', () => {
      load('# A\n\n- [x] one\n');
      const ghostHeading = Object.assign(document.createElement('h2'), { className: 'rm-chg-del', id: 'gone', textContent: 'Gone' });
      content.append(ghostHeading);
      addClone('ghost', 'todo');
      // A real item after the removed heading still belongs to A.
      content.insertAdjacentHTML(
        'beforeend',
        '<ul><li class="task-list-item"><label><input class="task-list-item-checkbox" type="checkbox"> late</label></li></ul>',
      );
      assert.deepEqual(counts(update()), { a: { total: 2, done: 1, active: 0 } });
    });

    // Removed clones keep `data-task`; the button once scrolled to such a ghost above the real item.
    it('the follow button reveals a real in-progress item, not a removed clone above it', () => {
      vscode.state = { uri: '', followTasks: false };
      load('- [/] real\n', { tops: { real: FAR } });
      addClone('ghost', 'active', { before: content.firstElementChild!, top: 50 });
      update();
      followButton.click();
      assert.equal(scrolls().at(-1)?.top, revealTop(FAR));
    });
  });

  // ---- feature off and on ---------------------------------------------------------------------

  describe('turning the feature off and on', () => {
    it('forgets the states: no flash for what happened while it was off', () => {
      load('- [/] a\n');
      update();
      load('- [x] a\n');
      update({ enabled: false });
      load('- [x] a\n');
      update();
      assert.deepEqual(flashed(), []);
    });

    it('forgets the states: the first render after switching on does not follow anything', () => {
      load('- [ ] a\n');
      update();
      update({ enabled: false });
      load('- [/] a\n', { tops: { a: FAR } });
      update();
      assert.deepEqual(scrolls(), []);
    });

    it('while off: no counts, no bar, no button', () => {
      load('- [x] a\n- [/] b\n');
      update();
      assert.equal(bar.hidden, false);
      assert.equal(followButton.hidden, false);
      const result = update({ enabled: false });
      assert.equal(result, undefined);
      assert.equal(bar.hidden, true);
      assert.equal(followButton.hidden, true);
    });

    it('while off nothing is scrolled', () => {
      startStep({ enabled: false });
      assert.deepEqual(scrolls(), []);
    });

    it('works again after being switched on (states are rebuilt)', () => {
      load('- [/] a\n');
      update({ enabled: false });
      update();
      load('- [x] a\n');
      update();
      assert.deepEqual(flashed(), ['a']);
    });
  });

  // ---- follow ---------------------------------------------------------------------------------

  describe('follow', () => {
    it('scrolls to a step that has just started, a third of the viewport from the top', () => {
      startStep();
      assert.equal(scrolls().length, 1);
      assert.ok(Math.abs(scrolls()[0].top - revealTop(FAR)) < 1e-9, String(scrolls()[0].top));
      assert.equal(scrolls()[0].behavior, 'instant');
    });

    it('is a programmatic scroll: the scroll event it causes is not echoed to the editor', () => {
      startStep();
      assert.equal(scrolls().length, 1);
      assert.equal(scroll.isSuppressed(), true);
      // The reader touches the page right after: inside the suppression window it is still not theirs.
      scroll.markUserScroll();
      layout.advance(99);
      assert.equal(scroll.isSuppressed(), true);
      layout.advance(1);
      assert.equal(scroll.isSuppressed(), false, 'the 100 ms window of scrollProgrammatically is over');
    });

    it('scrolls relative to the current scroll position', () => {
      layout.scrollY = 1_000;
      vscode.state = { uri: '', followTasks: true };
      load('- [ ] b\n');
      update();
      load('- [/] b\n', { tops: { b: 3_000 } });
      update();
      assert.ok(Math.abs(scrolls().at(-1)!.top - (1_000 + 2_000 - 800 / 3)) < 1e-9);
    });

    it('follows a step that was done and is reopened', () => {
      vscode.state = { uri: '', followTasks: true };
      load('- [x] b\n');
      update();
      load('- [/] b\n', { tops: { b: FAR } });
      update();
      assert.equal(scrolls().length, 1);
    });

    it('reveals only the first of several started steps', () => {
      vscode.state = { uri: '', followTasks: true };
      load('- [ ] a\n- [ ] b\n');
      update();
      load('- [/] a\n- [/] b\n', { tops: { a: 1_200, b: FAR } });
      update();
      assert.equal(scrolls().length, 1);
      assert.ok(Math.abs(scrolls()[0].top - revealTop(1_200)) < 1e-9);
    });

    it('expands the collapsed sections around the step, then invalidates the layout caches', () => {
      vscode.state = { uri: '', followTasks: true };
      const md = (mark: string): string => `# A\n\n## B\n\n- [${mark}] step\n`;
      load(md(' '));
      update();
      load(md('/'), { tops: { step: FAR }, sections: { collapsed: new Set(['a', 'b']) } });
      assert.equal(content.querySelectorAll('.rm-collapsed').length, 2);
      update();
      assert.equal(content.querySelectorAll('.rm-collapsed').length, 0, 'both ancestors expanded');
      assert.equal(invalidations, 1);
      assert.equal(scrolls().length, 1);
    });

    describe('does nothing', () => {
      it('on the first render', () => {
        vscode.state = { uri: '', followTasks: true };
        load('- [/] a\n', { tops: { a: FAR } });
        update();
        assert.deepEqual(scrolls(), []);
      });

      it('when following is off in the state (and leaves collapsed sections alone)', () => {
        vscode.state = { uri: '', followTasks: false };
        const md = (mark: string): string => `# A\n\n- [${mark}] step\n`;
        load(md(' '));
        update();
        load(md('/'), { tops: { step: FAR }, sections: { collapsed: new Set(['a']) } });
        update();
        assert.deepEqual(scrolls(), []);
        assert.equal(content.querySelectorAll('.rm-collapsed').length, 1);
        assert.equal(invalidations, 0);
      });

      it('when following was never set: it defaults to on', () => {
        vscode.state = undefined;
        load('- [ ] b\n');
        update();
        load('- [/] b\n', { tops: { b: FAR } });
        update();
        assert.equal(scrolls().length, 1);
      });

      it('while a block is being edited (busy)', () => {
        startStep({ busy: true });
        assert.deepEqual(scrolls(), []);
      });

      it('when no step started: items already in progress, finished, or only changed', () => {
        vscode.state = { uri: '', followTasks: true };
        load('- [/] a\n- [ ] b\n- [x] c\n');
        update();
        load('- [/] a\n- [x] b\n- [x] c\n', { tops: { a: FAR, b: FAR } });
        update();
        assert.deepEqual(scrolls(), [], 'a stayed in progress, b finished');
      });

      it('for a new item that is in progress (nothing to compare against)', () => {
        vscode.state = { uri: '', followTasks: true };
        load('- [ ] a\n');
        update();
        load('- [ ] a\n- [/] new step\n', { tops: { 'new step': FAR } });
        update();
        assert.deepEqual(scrolls(), []);
      });

      it('when the step is already in view', () => {
        vscode.state = { uri: '', followTasks: true };
        load('- [ ] b\n');
        update();
        load('- [/] b\n', { tops: { b: NEAR } });
        update();
        assert.deepEqual(scrolls(), []);
      });
    });

    describe('"already in view" margins (40px at both edges of an 800px viewport)', () => {
      const started = (top: number): void => {
        vscode.state = { uri: '', followTasks: true };
        load('- [ ] b\n');
        update();
        load('- [/] b\n', { tops: { b: top } });
        update();
      };

      it('40px from the top is in view, 39px is not', () => {
        started(40);
        assert.deepEqual(scrolls(), []);
        started(39);
        assert.equal(scrolls().length, 1);
      });

      it('760px (40px from the bottom) is in view, 761px is not', () => {
        started(760);
        assert.deepEqual(scrolls(), []);
        started(761);
        assert.equal(scrolls().length, 1);
      });

      it('an item above the viewport is revealed', () => {
        layout.scrollY = 2_000;
        started(1_000); // 1000px above the viewport top
        assert.ok(Math.abs(scrolls().at(-1)!.top - (2_000 - 1_000 - 800 / 3)) < 1e-9);
      });

      it('never scrolls to a negative position', () => {
        layout.scrollY = 500;
        started(100); // 400px above the viewport top, and less than a third of the viewport from the document top
        assert.equal(scrolls().at(-1)?.top, 0);
      });
    });

    describe('idle time (FOLLOW_IDLE_MS = 2000)', () => {
      it('not while the reader just scrolled', () => {
        scroll.markUserScroll();
        startStep();
        assert.deepEqual(scrolls(), []);
      });

      it('not at exactly 2000 ms after the last input', () => {
        scroll.markUserScroll();
        layout.advance(2_000);
        startStep();
        assert.deepEqual(scrolls(), []);
      });

      it('yes from 2001 ms on', () => {
        scroll.markUserScroll();
        layout.advance(2_001);
        startStep();
        assert.equal(scrolls().length, 1);
      });

      it('not while a pointer is held down (dragging the scrollbar), however long', () => {
        document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
        layout.advance(60_000);
        startStep();
        assert.deepEqual(scrolls(), []);
        document.body.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
      });

      it('each kind of input counts: wheel, touch, key', () => {
        for (const type of ['wheel', 'touchmove', 'keydown']) {
          layout.advance(1_000_000);
          layout.scrolls.length = 0;
          document.body.dispatchEvent(new window.Event(type, { bubbles: true }));
          startStep();
          assert.deepEqual(scrolls(), [], type);
        }
      });
    });
  });

  // ---- counts -----------------------------------------------------------------------------------

  describe('per-heading counts', () => {
    const MD = [
      '- [x] before any heading',
      '',
      '# A',
      '',
      '- [x] a1',
      '- [/] a2',
      '',
      '## B',
      '',
      '- [ ] b1',
      '- [x] b2',
      '',
      '### C',
      '',
      'no tasks here',
      '',
      '## D',
      '',
      'nothing',
      '',
      '# E',
      '',
      'plain text',
      '',
    ].join('\n');

    it('rolls nested headings up into their parents', () => {
      load(MD);
      assert.deepEqual(counts(update()), {
        a: { total: 4, done: 2, active: 1 },
        b: { total: 2, done: 1, active: 0 },
      });
    });

    it('drops headings without tasks (also those whose children have none)', () => {
      load(MD);
      const result = update()!;
      for (const slug of ['c', 'd', 'e']) assert.equal(result.has(slug), false, slug);
    });

    it('gives the same counts without collapsible sections', () => {
      load(MD, { sections: { collapsible: false } });
      assert.equal(content.querySelector('section'), null);
      assert.deepEqual(counts(update()), {
        a: { total: 4, done: 2, active: 1 },
        b: { total: 2, done: 1, active: 0 },
      });
    });

    it('does not count tasks before the first heading for any heading, but in the bar', () => {
      load(MD);
      update();
      assert.equal(bar.getAttribute('aria-valuemax'), '5');
    });

    it('sibling headings do not share counts, and a shallower heading closes the deeper ones', () => {
      load('# A\n\n## B\n\n### C\n\n- [ ] c\n\n## D\n\n- [x] d\n\n- [x] d2\n');
      assert.deepEqual(counts(update()), {
        a: { total: 3, done: 2, active: 0 },
        b: { total: 1, done: 0, active: 0 },
        c: { total: 1, done: 0, active: 0 },
        d: { total: 2, done: 2, active: 0 },
      });
    });

    it('a deeper heading directly under a shallow one still rolls up', () => {
      load('# A\n\n### C\n\n- [x] c\n');
      assert.deepEqual(counts(update()), {
        a: { total: 1, done: 1, active: 0 },
        c: { total: 1, done: 1, active: 0 },
      });
    });

    it('counts nested task items individually', () => {
      load('# A\n\n- [x] parent\n  - [ ] child\n  - [/] child 2\n');
      assert.deepEqual(counts(update()), { a: { total: 3, done: 1, active: 1 } });
    });

    it('ignores headings that are not outline headings (inside a blockquote); their tasks count for the enclosing one', () => {
      load('# A\n\n> ## Quoted\n>\n> - [x] q\n\n- [ ] a\n');
      assert.deepEqual(counts(update()), { a: { total: 2, done: 1, active: 0 } });
    });

    it('is empty when there are no tasks at all', () => {
      load('# A\n\ntext\n');
      assert.deepEqual(counts(update()), {});
    });

    it('is undefined when the progress display is off', () => {
      load(MD);
      assert.equal(update({ progress: false }), undefined);
    });
  });

  // ---- progress bar -----------------------------------------------------------------------------

  describe('progress bar', () => {
    it('shows done and in-progress shares and the totals', () => {
      load('- [x] a\n- [/] b\n- [ ] c\n- [ ] d\n');
      update();
      assert.equal(bar.hidden, false);
      assert.equal(bar.style.getPropertyValue('--rm-task-done'), '25%');
      assert.equal(bar.style.getPropertyValue('--rm-task-active'), '25%');
      assert.equal(bar.getAttribute('aria-valuemax'), '4');
      assert.equal(bar.getAttribute('aria-valuenow'), '1');
    });

    it('says what is done and what is in progress', () => {
      load('- [x] a\n- [/] b\n- [/] c\n- [ ] d\n- [x] e\n');
      update();
      assert.equal(bar.getAttribute('aria-valuetext'), '2 of 5 done · 2 in progress');
      assert.equal(bar.title, '2 of 5 done · 2 in progress');
    });

    it('leaves out the in-progress part when nothing is in progress', () => {
      load('- [x] a\n- [ ] b\n- [ ] c\n');
      update();
      assert.equal(bar.getAttribute('aria-valuetext'), '1 of 3 done');
      assert.equal(bar.style.getPropertyValue('--rm-task-active'), '0%');
    });

    it('is full when everything is done', () => {
      load('- [x] a\n- [x] b\n');
      update();
      assert.equal(bar.style.getPropertyValue('--rm-task-done'), '100%');
      assert.equal(bar.getAttribute('aria-valuetext'), '2 of 2 done');
    });

    it('is hidden when there are no tasks', () => {
      load('# Title\n\n- a plain list\n');
      update();
      assert.equal(bar.hidden, true);
    });

    it('hides again when the tasks go away', () => {
      load('- [x] a\n');
      update();
      assert.equal(bar.hidden, false);
      load('just text\n');
      update();
      assert.equal(bar.hidden, true);
    });

    it('is hidden when the progress display is off, though the feature is on', () => {
      load('- [x] a\n');
      update({ progress: false });
      assert.equal(bar.hidden, true);
    });

    it('updates in place as items are checked', () => {
      load('- [ ] a\n- [ ] b\n');
      update();
      assert.equal(bar.getAttribute('aria-valuenow'), '0');
      load('- [x] a\n- [ ] b\n');
      update();
      assert.equal(bar.getAttribute('aria-valuenow'), '1');
      assert.equal(bar.style.getPropertyValue('--rm-task-done'), '50%');
    });
  });

  // ---- follow button ----------------------------------------------------------------------------

  describe('follow button', () => {
    it('is shown only while a step is in progress', () => {
      load('- [x] a\n- [ ] b\n');
      update();
      assert.equal(followButton.hidden, true);
      load('- [x] a\n- [/] b\n');
      update();
      assert.equal(followButton.hidden, false);
      load('- [x] a\n- [x] b\n');
      update();
      assert.equal(followButton.hidden, true);
    });

    it('is shown without the progress bar (progress display off)', () => {
      load('- [/] a\n');
      update({ progress: false });
      assert.equal(followButton.hidden, false);
    });

    it('is pressed by default (following is on unless the state says otherwise)', () => {
      load('- [/] a\n');
      update();
      assert.equal(followButton.getAttribute('aria-pressed'), 'true');
      assert.equal(followButton.title, 'Stop following steps in progress');
    });

    it('is not pressed when the state turned following off', () => {
      vscode.state = { uri: '', followTasks: false };
      load('- [/] a\n');
      update();
      assert.equal(followButton.getAttribute('aria-pressed'), 'false');
      assert.equal(followButton.title, 'Follow steps in progress');
    });

    it('a click flips and persists followTasks, keeping the rest of the state', () => {
      vscode.state = { uri: 'file:///x.md', scrollLine: 12, followTasks: true };
      load('- [/] a\n');
      update();
      followButton.click();
      assert.equal(vscode.state?.followTasks, false);
      assert.equal(vscode.state?.scrollLine, 12);
      assert.equal(followButton.getAttribute('aria-pressed'), 'false');
      assert.equal(followButton.title, 'Follow steps in progress');
      followButton.click();
      assert.equal(vscode.state?.followTasks, true);
      assert.equal(followButton.getAttribute('aria-pressed'), 'true');
      assert.equal(followButton.title, 'Stop following steps in progress');
    });

    it('a click from the default state turns following off', () => {
      load('- [/] a\n');
      update();
      followButton.click();
      assert.equal(vscode.state?.followTasks, false);
    });

    it('turning following on scrolls to the first step in progress, even one in view', () => {
      vscode.state = { uri: '', followTasks: false };
      load('- [/] a\n- [/] b\n', { tops: { a: NEAR, b: FAR } });
      update();
      followButton.click();
      assert.equal(scrolls().length, 1);
      assert.ok(Math.abs(scrolls()[0].top - revealTop(NEAR)) < 1e-9, String(scrolls()[0].top));
      assert.equal(scroll.isSuppressed(), true);
    });

    it('turning following on expands the collapsed sections of that step', () => {
      vscode.state = { uri: '', followTasks: false };
      load('# A\n\n- [/] step\n', { tops: { step: FAR }, sections: { collapsed: new Set(['a']) } });
      update();
      followButton.click();
      assert.equal(content.querySelectorAll('.rm-collapsed').length, 0);
      assert.ok(Math.abs(scrolls().at(-1)!.top - revealTop(FAR)) < 1e-9);
    });

    it('turning following off does not scroll', () => {
      load('- [/] a\n', { tops: { a: FAR } });
      update();
      followButton.click();
      assert.deepEqual(scrolls(), []);
    });

    it('a click after following was switched off stops the follow for later renders', () => {
      load('- [ ] b\n');
      update();
      followButton.click(); // off
      load('- [/] b\n', { tops: { b: FAR } });
      update();
      assert.deepEqual(scrolls(), []);
    });
  });
});
