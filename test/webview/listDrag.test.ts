import * as assert from 'node:assert/strict';
import { isRenderedListMove } from '../../src/edit/rendered';
import type { EditError, FromWebview } from '../../src/protocol';
import { createMarkdownRenderer, type RenderResult } from '../../src/render/markdown';
import { applyMoveToSource, flowList, LIST_LEFT, LIST_WIDTH } from './listLayout';
import { useDom } from './dom';
import { useLayout } from './layout';
import { useVsCodeApi } from './vscodeApi';

// listDrag.ts pulls in api.ts (acquireVsCodeApi at import) and calls window.matchMedia at import, so
// everything is loaded after the DOM, the host API stub and the matchMedia stub exist.
type ListDrag = typeof import('../../webview/listDrag');
type Sanitize = typeof import('../../webview/sanitize');
type MoveMessage = Extract<FromWebview, { type: 'moveListItem' }>;

// Copies of the user-visible texts in listDrag.ts (not exported).
const MESSAGES: Record<EditError, string> = {
  stale: 'The file changed before the move was saved, so the list was put back.',
  readonly: 'This document is read-only.',
  invalid: 'This list could not be reordered in the source.',
  failed: 'VS Code could not apply the move.',
};
const ERRORS = Object.keys(MESSAGES) as EditError[];

/** Copy of SETTLE_MS: the glide of a dropped item before the move is sent. */
const SETTLE_MS = 200;

// Source lines (0-based): paragraph 0, items 2-5 (item ends 3, 4, 5, 6).
const FLAT = 'intro\n\n- alpha\n- beta\n- gamma\n- delta\n';
// Page layout of FLAT's list, which starts at y = 100: alpha 100-130, beta 130-150, gamma 150-170, delta 170-200
// (middles 115, 140, 160, 185). The outer items are taller than the inner ones so that every inner item can
// reach both ends of the list when dragged (the dragged item's middle has to pass the end item's middle).
const FLAT_HEIGHTS = [30, 20, 20, 30];
const BETA_MID = 140;

const GRIP_H = 20;
const GRIP_RIGHT = 6;
const GRIP_W = 12;

describe('list drag', () => {
  // getComputedStyle: showGrip calls it as a bare global, which Node does not have.
  useDom({ globals: ['getComputedStyle'] });
  const vscode = useVsCodeApi();
  const layout = useLayout();

  const render = createMarkdownRenderer();
  let listDrag: ListDrag;
  let sanitize: Sanitize['sanitize'];
  let removedSelector: string;
  let content: HTMLElement;
  let grip: HTMLButtonElement;
  let rendered: RenderResult;
  let source: string;
  let version: number | undefined;
  let busy = false;
  let reduced = false;

  // setTimeout is replaced for each test: the settle glide, the grip hide delay and the flash removal
  // run when the test says so.
  const realTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  const frames: (() => void)[] = [];
  const realFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const captured = new Set<number>();
  const animations: { el: Element; transforms: (string | undefined)[] }[] = [];

  before(async () => {
    const mediaQuery = {
      get matches() {
        return reduced;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => mediaQuery });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: (cb: () => void) => frames.push(cb),
    });
    // jsdom has no Web Animations.
    Object.defineProperty(window.Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value(this: Element, keyframes: { transform?: string }[]) {
        animations.push({ el: this, transforms: keyframes.map((k) => k.transform) });
        return {};
      },
    });
    listDrag = await import('../../webview/listDrag');
    ({ sanitize } = await import('../../webview/sanitize'));
    removedSelector = (await import('../../webview/changes')).REMOVED_SELECTOR;

    content = document.createElement('div');
    document.body.append(content);
    listDrag.initListDrag({ content, docVersion: () => version, isBusy: () => busy });
    grip = document.querySelector<HTMLButtonElement>('.rm-item-grip')!;
    // jsdom has no pointer capture.
    grip.setPointerCapture = (id: number) => void captured.add(id);
    grip.hasPointerCapture = (id: number) => captured.has(id);
    grip.releasePointerCapture = (id: number) => void captured.delete(id);
  });

  after(() => {
    if (realFrame) Object.defineProperty(globalThis, 'requestAnimationFrame', realFrame);
    else delete (globalThis as Record<string, unknown>).requestAnimationFrame;
  });

  beforeEach(() => {
    // useDom's beforeEach has emptied <body>; put the persistent elements back.
    document.body.className = '';
    document.body.append(content, grip);
    content.replaceChildren();
    version = 7;
    busy = false;
    reduced = false;
    frames.length = 0;
    animations.length = 0;
    captured.clear();
    timers.clear();
    globalThis.setTimeout = ((fn: () => void, ms = 0) => {
      timers.set(++timerId, { fn, ms });
      return timerId;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout;
    listDrag.setListDragEnabled(true);
  });

  afterEach(() => {
    // Leave the module in its initial state: nothing pending, no drag, edit off.
    listDrag.setListDragEnabled(false);
    listDrag.onMoveResult({ type: 'moveResult', ok: true });
    globalThis.setTimeout = realTimers.setTimeout;
    globalThis.clearTimeout = realTimers.clearTimeout;
    assert.equal(grip.hidden, true, 'test left the grip showing');
  });

  // ---- helpers ------------------------------------------------------------------------------

  /** Renders `markdown` the way main.ts does (real renderer + sanitize) into the preview root. */
  function load(markdown: string): void {
    rendered = render(markdown, { mermaid: true });
    source = markdown;
    content.replaceChildren(sanitize(rendered.html));
  }

  /** A new render replacing the content, as main.ts does it: the drag state is dropped first. */
  function rerender(markdown: string): void {
    listDrag.cancelListDrag();
    load(markdown);
  }

  const lists = (): HTMLElement[] => [...content.querySelectorAll<HTMLElement>('ul, ol')];
  const items = (list: HTMLElement): HTMLLIElement[] =>
    [...list.children].filter((c): c is HTMLLIElement => c.tagName === 'LI' && !c.matches(removedSelector));

  /** Gives the list's children page rectangles that follow the DOM. */
  function flow(list: HTMLElement, heights?: readonly number[], top = 100): void {
    flowList(list, {
      top,
      heights: heights ?? [...list.children].map((c) => (c.matches(removedSelector) ? 12 : 20)),
      scrollY: () => layout.scrollY,
    });
  }

  /** The item's own text (first line, without nested lists or checkboxes). */
  function label(li: Element): string {
    const copy = li.cloneNode(true) as Element;
    copy.querySelectorAll('ul, ol, input').forEach((e) => e.remove());
    return (copy.textContent ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  }
  const labels = (list: HTMLElement): string[] => items(list).map(label);

  /** Labels of the items of the list at `indent` between the lines the move covers. */
  function sourceLabels(text: string, msg: MoveMessage, indent: string): string[] {
    const marker = new RegExp(`^${indent}(?:[-*+]|\\d+[.)]) (?:\\[[ x]\\] )?(.*)$`);
    return text
      .split('\n')
      .slice(msg.starts[0], msg.end)
      .map((l) => marker.exec(l)?.[1])
      .filter((l): l is string => l !== undefined);
  }

  const mouse = (target: Element, type: string, init: MouseEventInit = {}): void => {
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  };
  function flushFrames(): void {
    const pending = [...frames];
    frames.length = 0;
    for (const fn of pending) fn();
  }
  /** Moves the pointer over `el` (the hover listener runs on an animation frame). */
  function hover(el: Element, clientY = 0): void {
    mouse(el, 'mousemove', { clientY });
    flushFrames();
  }
  /** Shows the grip on `li` as hovering does, and focuses it as a keyboard user would. */
  function focusGripOn(li: Element): void {
    hover(li);
    assert.equal(grip.hidden, false, 'the grip is showing');
    grip.focus();
  }
  function key(init: KeyboardEventInit, target: EventTarget = grip): KeyboardEvent {
    const e = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  }
  const altDown = (): KeyboardEvent => key({ key: 'ArrowDown', altKey: true });
  const altUp = (): KeyboardEvent => key({ key: 'ArrowUp', altKey: true });
  function pointer(type: string, clientY: number, init: PointerEventInit = {}): void {
    grip.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientY, ...init }));
  }
  /** Runs the settle glide's timer (the item reaching its slot), if one is waiting. */
  function settle(): void {
    for (const [id, t] of [...timers]) {
      if (t.ms !== SETTLE_MS) continue;
      timers.delete(id);
      t.fn();
    }
  }
  /** Drags `li` (its middle at `y`) by `dy` and releases. */
  function dragBy(li: Element, y: number, dy: number): void {
    hover(li);
    pointer('pointerdown', y);
    pointer('pointermove', y + dy);
    pointer('pointerup', y + dy);
    settle();
  }

  const moves = (): MoveMessage[] => vscode.postedOfType('moveListItem');
  function onlyMove(): MoveMessage {
    assert.equal(moves().length, 1, `expected exactly one moveListItem, got ${JSON.stringify(vscode.posted)}`);
    return moves()[0];
  }

  /** What the host would do: accepts the payload only if it is one rendered list, and applies it. */
  function hostAccepts(msg: MoveMessage): { source: string; line: number } {
    assert.equal(isRenderedListMove(rendered.lists, msg.starts, msg.end), true, `the host would reject ${JSON.stringify(msg)}`);
    return applyMoveToSource(source, msg);
  }

  const result = (init: { ok: boolean; line?: number; error?: EditError }) => listDrag.onMoveResult({ type: 'moveResult', ...init });
  const flashes = (): HTMLElement[] => [...content.querySelectorAll<HTMLElement>('.rm-edit-flash')];
  const sameChildren = (list: HTMLElement, expected: readonly Element[]): boolean =>
    list.children.length === expected.length && expected.every((c, i) => list.children[i] === c);

  /** FLAT rendered and laid out; returns its list. */
  function loadFlat(): HTMLElement {
    load(FLAT);
    const [list] = lists();
    flow(list, FLAT_HEIGHTS);
    return list;
  }

  /** FLAT with track-changes copies in the list: after alpha, and at the end. */
  function loadFlatWithClones(): { list: HTMLElement; initial: Element[] } {
    load(FLAT);
    const [list] = lists();
    const [alpha, , , delta] = items(list);
    const removed = (text: string, cls: string): HTMLLIElement => {
      const li = document.createElement('li');
      li.className = cls; // the renderer's clones have no data-line / data-item-end
      li.textContent = text;
      return li;
    };
    alpha.after(removed('gone', 'rm-chg-del'));
    delta.after(removed('moved away', 'rm-chg-move-from'));
    flow(list, [30, 12, 20, 20, 30, 12]);
    return { list, initial: [...list.children] };
  }

  /** A keyboard move of beta (index 1) down one place in FLAT with track-changes copies; the host has not answered. */
  function moveWithClones(): { list: HTMLElement; initial: Element[] } {
    const fixture = loadFlatWithClones();
    focusGripOn(items(fixture.list)[1]);
    altDown();
    return fixture;
  }

  // ---- the grip ------------------------------------------------------------------------------

  describe('grip', () => {
    it('shows left of the hovered item, inside the list padding, centred on its first line', () => {
      const list = loadFlat();
      const [alpha, beta] = items(list);
      hover(beta);
      assert.equal(grip.hidden, false);
      // Left edge: the list's left + GRIP_RIGHT - GRIP_W; top: centred on the item (no line height in jsdom: its height).
      assert.equal(grip.style.left, `${LIST_LEFT + GRIP_RIGHT - GRIP_W}px`);
      assert.equal(grip.style.top, `${130 + (20 - GRIP_H) / 2}px`);
      hover(alpha);
      assert.equal(grip.style.top, `${100 + (30 - GRIP_H) / 2}px`);
    });

    it('is positioned in page coordinates when the page is scrolled', () => {
      const list = loadFlat();
      layout.scrollY = 50;
      hover(items(list)[0]);
      assert.equal(grip.style.top, `${100 + (30 - GRIP_H) / 2}px`, 'viewport top 50 plus the scroll offset 50');
    });

    it('has an accessible name and keyboard hint', () => {
      loadFlat();
      assert.equal(grip.type, 'button');
      assert.match(grip.getAttribute('aria-label') ?? '', /Alt\+Up or Alt\+Down/);
    });

    it('is not shown while edit is off, and goes away when edit is turned off', () => {
      const list = loadFlat();
      listDrag.setListDragEnabled(false);
      hover(items(list)[1]);
      assert.equal(grip.hidden, true);
      listDrag.setListDragEnabled(true);
      hover(items(list)[1]);
      assert.equal(grip.hidden, false);
      listDrag.setListDragEnabled(false);
      assert.equal(grip.hidden, true);
    });

    it('is not shown for a list with a single item', () => {
      load('- only\n');
      hover(content.querySelector('li')!);
      assert.equal(grip.hidden, true);
    });

    it('is not shown for items without source positions (anything the renderer did not stamp)', () => {
      const list = loadFlat();
      const [alpha, beta] = items(list);
      beta.removeAttribute('data-item-end');
      hover(alpha);
      assert.equal(grip.hidden, true, 'one unstamped sibling makes the whole list unmovable');
      beta.setAttribute('data-item-end', '4');
      beta.removeAttribute('data-line');
      hover(alpha);
      assert.equal(grip.hidden, true);
    });

    it('is not shown inside a block quote', () => {
      load('> - a\n> - b\n');
      hover(content.querySelector('li')!);
      assert.equal(grip.hidden, true);
    });

    it('is not shown for a list outside the preview content', () => {
      loadFlat();
      const outside = content.cloneNode(true) as HTMLElement;
      document.body.append(outside);
      hover(outside.querySelector('li')!);
      assert.equal(grip.hidden, true);
    });

    it('is not shown on a track-changes copy of a removed item, nor on a moved-from copy', () => {
      const { list } = loadFlatWithClones();
      for (const clone of list.querySelectorAll('li.rm-chg-del, li.rm-chg-move-from')) {
        hover(clone);
        assert.equal(grip.hidden, true, `grip on a ${clone.className} copy`);
      }
      hover(items(list)[1]);
      assert.equal(grip.hidden, false, 'a real item still gets it');
    });

    it('is not shown on a list inside a removed block copy', () => {
      load(FLAT);
      const copy = document.createElement('div');
      copy.className = 'rm-chg-del';
      copy.innerHTML = '<ul><li>gone a</li><li>gone b</li></ul>'; // clones carry no data-line
      content.append(copy);
      hover(copy.querySelector('li')!);
      assert.equal(grip.hidden, true);
    });

    it('over the list padding or a gap, goes to the nearest real item and never to a copy', () => {
      const { list } = loadFlatWithClones();
      const [alpha, beta] = items(list);
      // Rects: alpha 100-130, copy 130-142, beta 142-162. The copy's row belongs to its nearest real item.
      hover(list, 135);
      assert.equal(grip.hidden, false);
      assert.equal(grip.style.top, `${alpha.getBoundingClientRect().top + (30 - GRIP_H) / 2}px`, 'alpha is nearer (5 px) than beta (7 px)');
      hover(list, 150);
      assert.equal(grip.style.top, `${beta.getBoundingClientRect().top + (20 - GRIP_H) / 2}px`);
    });

    it('is not shown while the block editor is open (isBusy)', () => {
      const list = loadFlat();
      busy = true;
      hover(items(list)[1]);
      assert.equal(grip.hidden, true);
    });

    it('is hidden after a delay once the pointer leaves, but not while the pointer is on it', () => {
      const list = loadFlat();
      hover(items(list)[1]);
      const hideTimers = (): { fn: () => void }[] => [...timers.values()].filter((t) => t.ms === 400);
      hover(content); // not an item
      assert.equal(grip.hidden, false, 'delayed');
      assert.equal(hideTimers().length, 1, 'a hide timer is waiting');
      hover(grip);
      assert.equal(hideTimers().length, 0, 'hovering the grip cancels the hide');
      assert.equal(grip.hidden, false);
      hover(content);
      for (const t of hideTimers()) t.fn();
      assert.equal(grip.hidden, true);
    });
  });

  // ---- keyboard ------------------------------------------------------------------------------

  describe('keyboard', () => {
    it('Alt+Down moves the item one place down and posts the move', () => {
      const list = loadFlat();
      const [alpha, beta, gamma, delta] = items(list);
      focusGripOn(beta);
      const e = altDown();
      assert.equal(e.defaultPrevented, true);
      assert.deepEqual(items(list), [alpha, gamma, beta, delta]);
      assert.deepEqual(vscode.posted, [{ type: 'moveListItem', starts: [2, 3, 4, 5], end: 6, from: 1, to: 2, docVersion: 7 }]);
    });

    it('Alt+Up moves the item one place up and posts the move', () => {
      const list = loadFlat();
      const [alpha, beta, gamma, delta] = items(list);
      focusGripOn(gamma);
      altUp();
      assert.deepEqual(items(list), [alpha, gamma, beta, delta]);
      assert.deepEqual(vscode.posted, [{ type: 'moveListItem', starts: [2, 3, 4, 5], end: 6, from: 2, to: 1, docVersion: 7 }]);
    });

    it('the payload cites the version of the render that is shown', () => {
      const list = loadFlat();
      version = 31;
      focusGripOn(items(list)[0]);
      altDown();
      assert.equal(onlyMove().docVersion, 31);
    });

    it('does nothing at the ends, but still keeps the key from scrolling the page', () => {
      const list = loadFlat();
      const before = items(list);
      focusGripOn(before[0]);
      assert.equal(altUp().defaultPrevented, true);
      focusGripOn(before[3]);
      assert.equal(altDown().defaultPrevented, true);
      assert.deepEqual(vscode.posted, []);
      assert.deepEqual(items(list), before);
    });

    it('ignores the arrows without Alt, and other keys with Alt', () => {
      const list = loadFlat();
      const before = items(list);
      focusGripOn(before[1]);
      assert.equal(key({ key: 'ArrowDown' }).defaultPrevented, false);
      assert.equal(key({ key: 'ArrowUp', ctrlKey: true }).defaultPrevented, false);
      assert.equal(key({ key: 'Enter', altKey: true }).defaultPrevented, false);
      assert.equal(key({ key: 'a', altKey: true }).defaultPrevented, false);
      assert.deepEqual(vscode.posted, []);
      assert.deepEqual(items(list), before);
    });

    it('does nothing when no item is under the grip, or edit is off', () => {
      const list = loadFlat();
      const before = items(list);
      hover(before[1]);
      listDrag.setListDragEnabled(false);
      altDown();
      listDrag.setListDragEnabled(true);
      altDown(); // the grip was hidden: its item is forgotten
      assert.deepEqual(vscode.posted, []);
      assert.deepEqual(items(list), before);
    });

    it('does nothing while another editor is open (isBusy)', () => {
      const list = loadFlat();
      const before = items(list);
      focusGripOn(before[1]);
      busy = true;
      altDown();
      assert.deepEqual(vscode.posted, []);
      assert.deepEqual(items(list), before);
    });

    it('does nothing when the item left the DOM (a render replaced the list)', () => {
      const list = loadFlat();
      focusGripOn(items(list)[1]);
      content.replaceChildren();
      altDown();
      assert.deepEqual(vscode.posted, []);
    });

    it('glides the items that changed place (animations, not when reduced motion is set)', () => {
      const list = loadFlat();
      const [, beta, gamma] = items(list);
      focusGripOn(beta);
      altDown();
      assert.deepEqual(
        animations.map((a) => [a.el, a.transforms]),
        [
          [beta, ['translateY(-20px)', 'none']],
          [gamma, ['translateY(20px)', 'none']],
        ],
      );
    });

    it('does not animate with reduced motion, but moves and posts the same', () => {
      reduced = true;
      const list = loadFlat();
      const [alpha, beta, gamma, delta] = items(list);
      focusGripOn(beta);
      altDown();
      assert.deepEqual(animations, []);
      assert.deepEqual(items(list), [alpha, gamma, beta, delta]);
      assert.equal(onlyMove().to, 2);
    });

    it('moves a list with track-changes copies without counting them as items', () => {
      const { list } = loadFlatWithClones();
      const [alpha, beta, gamma, delta] = items(list);
      focusGripOn(beta);
      altDown();
      assert.deepEqual(items(list), [alpha, gamma, beta, delta]);
      assert.deepEqual(vscode.posted, [{ type: 'moveListItem', starts: [2, 3, 4, 5], end: 6, from: 1, to: 2, docVersion: 7 }]);
    });

    it('keeps the grip on the moved item and focused once the new render is in, so it can move again', () => {
      const list = loadFlat();
      focusGripOn(items(list)[1]); // beta
      altDown();
      const host = hostAccepts(onlyMove());
      vscode.clear();
      // The host renders the new source, then replies.
      rerender(host.source);
      flow(lists()[0], FLAT_HEIGHTS);
      assert.equal(host.line, 4, 'beta now starts at line 4');
      result({ ok: true, line: host.line });
      const moved = content.querySelector<HTMLElement>('li[data-line="4"]')!;
      assert.equal(label(moved), 'beta');
      assert.equal(grip.hidden, false);
      assert.equal(document.activeElement, grip);
      // positioned on beta in its new place (page y 150-170)
      assert.equal(grip.style.top, `${moved.getBoundingClientRect().top + (20 - GRIP_H) / 2}px`);
      assert.equal(moved.getBoundingClientRect().top, 150);

      altDown(); // the same grip keeps moving the same item
      const second = onlyMove();
      assert.deepEqual([second.from, second.to, second.starts], [2, 3, [2, 3, 4, 5]]);
      assert.deepEqual(labels(lists()[0]), ['alpha', 'gamma', 'delta', 'beta']);
    });

    it('does not take focus for a pointer drag, and hides the grip after a successful result', () => {
      const list = loadFlat();
      const beta = items(list)[1];
      dragBy(beta, BETA_MID, 50);
      const host = hostAccepts(onlyMove());
      rerender(host.source);
      result({ ok: true, line: host.line });
      assert.equal(grip.hidden, true);
      assert.notEqual(document.activeElement, grip);
    });

    it('does not attach the grip to anything when the moved item is not in the new render', () => {
      const list = loadFlat();
      focusGripOn(items(list)[1]);
      altDown();
      rerender(FLAT);
      result({ ok: true, line: 99 });
      altDown(); // no item is attached to the grip any more
      assert.equal(moves().length, 1);
    });
  });

  // ---- pointer drag --------------------------------------------------------------------------

  describe('pointer drag', () => {
    // [item index, pointer travel, expected target] for FLAT (see the layout comment above): the
    // dragged item's middle (animated) or the pointer (reduced motion) has to pass a middle to move.
    const DRAGS: [number, number, number][] = [
      [1, 50, 3], // beta to the end
      [1, -30, 0], // beta to the start
      [1, 21, 2], // beta just past gamma's middle
      [2, -25, 1], // gamma up one
      [1, 20, 1], // not quite past gamma's middle: stays
    ];
    for (const reducedMotion of [false, true]) {
      for (const [idx, dy, to] of DRAGS) {
        it(`${reducedMotion ? 'reduced motion: ' : ''}dragging item ${idx} by ${dy}px ${to === idx ? 'leaves it' : `moves it to ${to}`}`, () => {
          reduced = reducedMotion;
          const list = loadFlat();
          const before = items(list);
          const mid = [115, 140, 160, 185][idx];
          dragBy(before[idx], mid, dy);

          const expected = [...before];
          expected.splice(idx, 1);
          expected.splice(to, 0, before[idx]);
          assert.deepEqual(items(list), expected);
          if (to === idx) {
            assert.deepEqual(vscode.posted, []);
            return;
          }
          const msg = onlyMove();
          assert.deepEqual(msg, { type: 'moveListItem', starts: [2, 3, 4, 5], end: 6, from: idx, to, docVersion: 7 });
          // What the host makes of it matches what the preview already shows.
          assert.deepEqual(sourceLabels(hostAccepts(msg).source, msg, ''), labels(list));
        });
      }
    }

    it('measures page positions, so a scrolled page gives the same result', () => {
      layout.scrollY = 40;
      const list = loadFlat();
      dragBy(items(list)[1], BETA_MID - 40, 50);
      assert.deepEqual([onlyMove().from, onlyMove().to], [1, 3]);
    });

    it('follows the page scrolling under a still pointer', () => {
      const list = loadFlat();
      const [alpha, beta, gamma, delta] = items(list);
      hover(beta);
      pointer('pointerdown', BETA_MID);
      layout.scrollY = 50; // the pointer stays at clientY 140, which is now page y 190
      window.dispatchEvent(new window.Event('scroll'));
      pointer('pointerup', BETA_MID);
      settle();
      assert.deepEqual(items(list), [alpha, gamma, delta, beta]);
      assert.equal(onlyMove().to, 3);
    });

    it('ignores scrolling after the drag ended', () => {
      const list = loadFlat();
      dragBy(items(list)[1], BETA_MID, 10);
      assert.doesNotThrow(() => window.dispatchEvent(new window.Event('scroll')));
      assert.deepEqual(vscode.posted, []);
    });

    it('measures the items with track-changes copies hidden', () => {
      // Without the copy between alpha and beta (12 px) beta's travel to the first place is 30 px.
      const { list } = loadFlatWithClones();
      const [alpha, beta] = items(list);
      hover(beta);
      pointer('pointerdown', BETA_MID);
      assert.equal(list.classList.contains('rm-list-reordering'), true);
      pointer('pointermove', BETA_MID - 30);
      pointer('pointerup', BETA_MID - 30);
      settle();
      assert.equal(items(list)[0], beta);
      assert.equal(items(list)[1], alpha);
      assert.deepEqual([onlyMove().from, onlyMove().to, onlyMove().starts], [1, 0, [2, 3, 4, 5]]);
      assert.equal(list.classList.contains('rm-list-reordering'), false);
    });

    it('does not count the track-changes copies as items, and keeps them in the list', () => {
      const { list } = loadFlatWithClones();
      const [alpha, beta, gamma, delta] = items(list);
      dragBy(beta, BETA_MID, 50);
      assert.deepEqual(items(list), [alpha, gamma, delta, beta]);
      assert.equal(list.querySelectorAll(removedSelector).length, 2);
      assert.deepEqual(onlyMove(), { type: 'moveListItem', starts: [2, 3, 4, 5], end: 6, from: 1, to: 3, docVersion: 7 });
    });

    it('a drag that ends where it started posts nothing and leaves the list alone', () => {
      const list = loadFlat();
      const before = [...list.children];
      dragBy(items(list)[1], BETA_MID, 46);
      assert.equal(sameChildren(list, before), false, 'fixture: the drag did move it');
      assert.equal(onlyMove().to, 3);
      vscode.clear();
      result({ ok: true });

      load(FLAT);
      const fresh = lists()[0];
      flow(fresh, FLAT_HEIGHTS);
      const original = [...fresh.children];
      hover(items(fresh)[1]);
      pointer('pointerdown', BETA_MID);
      pointer('pointermove', BETA_MID + 46); // down at the end ...
      pointer('pointermove', BETA_MID + 1); // ... and back near the start
      pointer('pointerup', BETA_MID + 1);
      settle();
      assert.deepEqual(vscode.posted, []);
      assert.equal(sameChildren(fresh, original), true);
    });

    it('lifts the item and slides the siblings apart while dragging (animated)', () => {
      const list = loadFlat();
      const [alpha, beta, gamma, delta] = items(list);
      hover(beta);
      pointer('pointerdown', BETA_MID);
      assert.equal(beta.classList.contains('rm-li-lifted'), true);
      assert.equal(document.body.classList.contains('rm-list-dragging'), true);
      assert.equal(grip.classList.contains('rm-item-grip-dragging'), true);
      assert.equal(list.classList.contains('rm-list-reordering'), true);
      pointer('pointermove', BETA_MID + 50);
      assert.equal(beta.style.transform, 'translateY(50px)');
      assert.deepEqual([alpha, gamma, delta].map((li) => li.style.transform), ['', 'translateY(-20px)', 'translateY(-20px)']);
      pointer('pointermove', BETA_MID - 30);
      assert.equal(beta.style.transform, 'translateY(-30px)');
      assert.deepEqual([alpha, gamma, delta].map((li) => li.style.transform), ['translateY(20px)', '', '']);
      pointer('pointermove', BETA_MID + 500);
      assert.equal(beta.style.transform, 'translateY(50px)', 'the travel stops at the end of the list');
    });

    it('settles into the slot before the move is posted, and refuses a new drag meanwhile', () => {
      const list = loadFlat();
      const [alpha, beta, gamma, delta] = items(list);
      hover(beta);
      pointer('pointerdown', BETA_MID);
      pointer('pointermove', BETA_MID + 50);
      pointer('pointerup', BETA_MID + 50);
      assert.equal(beta.classList.contains('rm-li-settling'), true);
      assert.equal(beta.style.transform, 'translateY(50px)', 'glides by the slots it passed');
      assert.deepEqual(vscode.posted, []);
      assert.deepEqual(items(list), [alpha, beta, gamma, delta], 'the DOM changes when the glide ends');

      pointer('pointerdown', 120); // refused: no second drag starts
      assert.equal(alpha.classList.contains('rm-li-lifted'), false);
      altDown();
      assert.deepEqual(vscode.posted, [], 'the keyboard is refused too');

      settle();
      assert.deepEqual(items(list), [alpha, gamma, delta, beta]);
      assert.equal(onlyMove().to, 3);
      for (const li of [alpha, beta, gamma, delta]) {
        assert.equal(li.style.transform, '', 'transforms are cleared');
        assert.equal(li.classList.contains('rm-li-lifted'), false);
        assert.equal(li.classList.contains('rm-li-settling'), false);
      }
      assert.equal(document.body.classList.contains('rm-list-dragging'), false);
      assert.equal(grip.classList.contains('rm-item-grip-dragging'), false);
      assert.equal(list.classList.contains('rm-list-reordering'), false);
      assert.equal(grip.hidden, true);
    });

    it('with reduced motion shows a drop line and snaps to the new order on release', () => {
      reduced = true;
      const list = loadFlat();
      const [alpha, beta, gamma, delta] = items(list);
      hover(beta);
      pointer('pointerdown', BETA_MID);
      assert.equal(beta.classList.contains('rm-li-drag-source'), true);
      assert.equal(beta.classList.contains('rm-li-lifted'), false);
      const line = document.querySelector<HTMLElement>('.rm-drop-line')!;
      assert.ok(line);
      pointer('pointermove', BETA_MID + 46); // past delta's middle (185)
      assert.equal(line.hidden, false);
      assert.equal(line.style.top, '201px', 'below the last item');
      assert.equal(line.style.left, `${LIST_LEFT + GRIP_RIGHT}px`);
      assert.equal(line.style.width, `${LIST_WIDTH - GRIP_RIGHT}px`);
      assert.deepEqual(items(list), [alpha, beta, gamma, delta], 'nothing moves until release');
      assert.equal(beta.style.transform, '');

      pointer('pointermove', 110); // above alpha's middle (115): before the first item
      assert.equal(line.hidden, false);
      assert.equal(line.style.top, '98px');
      pointer('pointermove', 125); // between alpha's and beta's middles: right where beta is
      assert.equal(line.hidden, true, 'no line for a no-op');

      pointer('pointermove', BETA_MID + 46);
      pointer('pointerup', BETA_MID + 46);
      assert.equal(document.querySelector('.rm-drop-line'), null, 'the line is removed');
      assert.deepEqual(items(list), [alpha, gamma, delta, beta], 'no waiting for a glide');
      assert.equal(onlyMove().to, 3);
      assert.equal(beta.classList.contains('rm-li-drag-source'), false);
    });

    it('ignores a press that is not the main button', () => {
      const list = loadFlat();
      hover(items(list)[1]);
      pointer('pointerdown', BETA_MID, { button: 2 });
      assert.equal(document.body.classList.contains('rm-list-dragging'), false);
      assert.equal(list.classList.contains('rm-list-reordering'), false);
    });

    it('ignores a press while another editor is open', () => {
      const list = loadFlat();
      hover(items(list)[1]);
      busy = true;
      pointer('pointerdown', BETA_MID);
      assert.equal(document.body.classList.contains('rm-list-dragging'), false);
    });

    it('ignores moves and releases of another pointer', () => {
      const list = loadFlat();
      const before = items(list);
      hover(before[1]);
      pointer('pointerdown', BETA_MID);
      pointer('pointermove', BETA_MID + 50, { pointerId: 2 });
      assert.equal(before[1].style.transform, '', 'the other pointer moved nothing');
      pointer('pointerup', BETA_MID + 50, { pointerId: 2 });
      assert.equal(document.body.classList.contains('rm-list-dragging'), true, 'still dragging');
      pointer('pointerup', BETA_MID, { pointerId: 1 });
      settle();
      assert.deepEqual(vscode.posted, [], 'released where it started');
    });

    it('captures the pointer on the grip and lets it go at the end', () => {
      const list = loadFlat();
      hover(items(list)[1]);
      pointer('pointerdown', BETA_MID, { pointerId: 5 });
      assert.equal(captured.has(5), true);
      pointer('pointerup', BETA_MID, { pointerId: 5 });
      assert.equal(captured.has(5), false);
      settle();
    });

    for (const [name, cancel] of [
      ['Escape', () => key({ key: 'Escape' }, window)],
      ['pointercancel', () => pointer('pointercancel', BETA_MID + 50)],
      ['losing the pointer capture', () => grip.dispatchEvent(new window.Event('lostpointercapture'))],
    ] as const) {
      it(`${name} cancels the drag: the item glides back and nothing is posted`, () => {
        const list = loadFlat();
        const before = [...list.children];
        const beta = items(list)[1];
        hover(beta);
        pointer('pointerdown', BETA_MID);
        pointer('pointermove', BETA_MID + 50);
        cancel();
        assert.equal(beta.style.transform, '', 'back to its own slot (no offset)');
        settle();
        assert.deepEqual(vscode.posted, []);
        assert.equal(sameChildren(list, before), true);
        assert.equal(document.body.classList.contains('rm-list-dragging'), false);
        assert.equal(list.classList.contains('rm-list-reordering'), false);
        assert.equal(beta.classList.contains('rm-li-lifted'), false);
        assert.deepEqual(
          items(list).map((li) => li.style.transform),
          ['', '', '', ''],
        );
      });
    }

    it('Escape is captured while dragging, and is left alone otherwise', () => {
      const list = loadFlat();
      let reached = 0;
      const count = (): void => void reached++;
      document.body.addEventListener('keydown', count);
      hover(items(list)[1]);
      assert.equal(key({ key: 'Escape' }).defaultPrevented, false);
      assert.equal(reached, 1);
      pointer('pointerdown', BETA_MID);
      const e = key({ key: 'Escape' });
      assert.equal(e.defaultPrevented, true);
      assert.equal(reached, 1, 'not passed on while it cancels a drag');
      settle();
      document.body.removeEventListener('keydown', count);
    });

    it('turning edit off or a new render (cancelListDrag) drops a drag at once, without a move', () => {
      for (const drop of [() => listDrag.setListDragEnabled(false), () => listDrag.cancelListDrag()]) {
        const list = loadFlat();
        const before = [...list.children];
        const beta = items(list)[1];
        hover(beta);
        pointer('pointerdown', BETA_MID);
        pointer('pointermove', BETA_MID + 50);
        drop();
        assert.deepEqual(vscode.posted, []);
        assert.equal(sameChildren(list, before), true);
        assert.equal(beta.style.transform, '');
        assert.equal(document.body.classList.contains('rm-list-dragging'), false);
        assert.equal(list.classList.contains('rm-list-reordering'), false);
        pointer('pointermove', BETA_MID + 50); // listeners are gone: nothing throws, nothing moves
        assert.equal(beta.style.transform, '');
        listDrag.setListDragEnabled(true);
        listDrag.cancelListDrag();
      }
    });

    it('with reduced motion, a render during the drag also drops it without a move', () => {
      reduced = true;
      const list = loadFlat();
      hover(items(list)[1]);
      pointer('pointerdown', BETA_MID);
      pointer('pointermove', BETA_MID + 50);
      rerender(FLAT);
      pointer('pointerup', BETA_MID + 50);
      assert.deepEqual(vscode.posted, []);
      assert.equal(document.querySelector('.rm-drop-line'), null);
    });

    it('a render replacing the list while the dropped item glides drops the move', () => {
      const list = loadFlat();
      hover(items(list)[1]);
      pointer('pointerdown', BETA_MID);
      pointer('pointermove', BETA_MID + 50);
      pointer('pointerup', BETA_MID + 50);
      rerender(FLAT); // the new content: the old list is gone and its line numbers with it
      assert.notEqual(lists()[0], list);
      settle();
      assert.deepEqual(vscode.posted, [], 'no post against a stale list');
      assert.equal(document.body.classList.contains('rm-list-dragging'), false);
      assert.equal(grip.classList.contains('rm-item-grip-dragging'), false);

      // The module is usable again.
      flow(lists()[0], FLAT_HEIGHTS);
      focusGripOn(items(lists()[0])[0]);
      altDown();
      assert.equal(onlyMove().to, 1);
    });

    it('a render during the glide that did not go through cancelListDrag also drops the move', () => {
      const list = loadFlat();
      hover(items(list)[1]);
      pointer('pointerdown', BETA_MID);
      pointer('pointermove', BETA_MID + 50);
      pointer('pointerup', BETA_MID + 50);
      content.replaceChildren(sanitize(render(FLAT, { mermaid: true }).html));
      settle();
      assert.deepEqual(vscode.posted, []);
    });
  });

  // ---- optimistic reorder and the result -----------------------------------------------------

  describe('moveResult', () => {
    it('reorders the DOM before the host answers (optimistic)', () => {
      const { list, initial } = moveWithClones();
      assert.equal(sameChildren(list, initial), false);
      assert.deepEqual(labels(list), ['alpha', 'gamma', 'beta', 'delta']);
      assert.equal(onlyMove().to, 2);
    });

    it('a successful result keeps the new order and shows no message', () => {
      const { list } = moveWithClones();
      const after = [...list.children];
      result({ ok: true, line: 4 });
      assert.equal(sameChildren(list, after), true);
      assert.deepEqual(flashes(), []);
    });

    it('a failed result puts every child back in place, track-changes copies included', () => {
      const { list, initial } = moveWithClones();
      result({ ok: false, error: 'stale' });
      assert.equal(sameChildren(list, initial), true);
      assert.deepEqual(
        [...list.children].map((c) => (c.matches(removedSelector) ? 'copy' : label(c))),
        ['alpha', 'copy', 'beta', 'gamma', 'delta', 'copy'],
      );
    });

    it('a failed result after a pointer drag restores the order too', () => {
      const { list, initial } = loadFlatWithClones();
      dragBy(items(list)[1], BETA_MID, 50);
      assert.equal(sameChildren(list, initial), false);
      result({ ok: false, error: 'invalid' });
      assert.equal(sameChildren(list, initial), true);
      assert.equal(list.classList.contains('rm-list-reordering'), false);
    });

    for (const error of ERRORS) {
      it(`a failed result ("${error}") shows its message under the list and hides the grip`, () => {
        const { list } = moveWithClones();
        result({ ok: false, error });
        const [note] = flashes();
        assert.equal(note.textContent, MESSAGES[error]);
        assert.equal(note.getAttribute('role'), 'status');
        assert.equal(list.nextElementSibling, note);
        assert.equal(grip.hidden, true);
        assert.notEqual(document.activeElement, grip, 'the focused grip is blurred');
        for (const t of [...timers.values()].filter((t) => t.ms === 4000)) t.fn();
        assert.deepEqual(flashes(), [], 'the message goes away by itself');
      });
    }

    it('a failed result without an error code shows the generic message', () => {
      moveWithClones();
      result({ ok: false });
      assert.equal(flashes()[0].textContent, MESSAGES.failed);
    });

    it('a failed result after the list was replaced puts nothing back into the new content', () => {
      const { list } = moveWithClones();
      rerender(FLAT);
      const fresh = lists()[0];
      const before = [...fresh.children];
      result({ ok: false, error: 'stale' });
      assert.equal(sameChildren(fresh, before), true);
      assert.notEqual(fresh, list);
      assert.deepEqual(flashes(), []);
    });

    it('a failed result when some child left the list restores nothing', () => {
      const { list } = moveWithClones();
      const order = [...list.children];
      order[3].remove(); // e.g. a track-changes pass removed a copy
      const rest = [...list.children];
      result({ ok: false, error: 'failed' });
      assert.equal(sameChildren(list, rest), true);
    });

    it('with no docVersion yet the move is not posted and the list is put back at once', () => {
      version = undefined;
      const list = loadFlat();
      const before = [...list.children];
      focusGripOn(items(list)[1]);
      altDown();
      assert.deepEqual(vscode.posted, []);
      assert.equal(sameChildren(list, before), true);
      assert.equal(flashes()[0].textContent, MESSAGES.failed);
      // pending was cleared again (and the grip hidden): the next move goes through.
      version = 7;
      focusGripOn(items(list)[1]);
      altDown();
      assert.equal(onlyMove().from, 1);
    });

  });

  // ---- pending -------------------------------------------------------------------------------

  describe('pending move', () => {
    it('refuses another keyboard move until the host answers', () => {
      const list = loadFlat();
      const [alpha, beta, gamma, delta] = items(list);
      focusGripOn(beta);
      altDown();
      const afterFirst = items(list);
      assert.deepEqual(afterFirst, [alpha, gamma, beta, delta]);
      altDown();
      altUp();
      assert.equal(moves().length, 1);
      assert.deepEqual(items(list), afterFirst);
    });

    it('refuses a drag until the host answers', () => {
      const list = loadFlat();
      focusGripOn(items(list)[1]);
      altDown();
      const afterFirst = items(list);
      pointer('pointerdown', BETA_MID);
      assert.equal(document.body.classList.contains('rm-list-dragging'), false);
      pointer('pointermove', BETA_MID + 50);
      pointer('pointerup', BETA_MID + 50);
      settle();
      assert.equal(moves().length, 1);
      assert.deepEqual(items(list), afterFirst);
    });

    it('shows no grip on hover while a move is pending', () => {
      const list = loadFlat();
      focusGripOn(items(list)[1]);
      altDown();
      (document.activeElement as HTMLElement).blur();
      listDrag.cancelListDrag(); // hides the grip, as a render does
      hover(items(list)[0]);
      assert.equal(grip.hidden, true);
      result({ ok: true });
      hover(items(list)[0]);
      assert.equal(grip.hidden, false);
      listDrag.cancelListDrag();
    });

    it('a successful result lets the next move through', () => {
      const list = loadFlat();
      focusGripOn(items(list)[1]);
      altDown();
      result({ ok: true });
      focusGripOn(items(list)[0]);
      altDown();
      assert.equal(moves().length, 2);
    });

    it('a failed result lets the next move through', () => {
      const list = loadFlat();
      focusGripOn(items(list)[1]);
      altDown();
      result({ ok: false, error: 'failed' });
      focusGripOn(items(list)[0]);
      altDown();
      assert.equal(moves().length, 2);
      assert.equal(moves()[1].from, 0);
    });

    it('is not cleared by a render or by turning edit off and on, only by the result', () => {
      const list = loadFlat();
      focusGripOn(items(list)[1]);
      altDown();
      listDrag.cancelListDrag();
      listDrag.setListDragEnabled(false);
      listDrag.setListDragEnabled(true);
      rerender(FLAT);
      flow(lists()[0], FLAT_HEIGHTS);
      hover(items(lists()[0])[0]);
      assert.equal(grip.hidden, true, 'still waiting for the first move');
      result({ ok: true });
      focusGripOn(items(lists()[0])[0]);
      altDown();
      assert.equal(moves().length, 2);
    });

    it('a result when nothing is pending does nothing', () => {
      const list = loadFlat();
      const before = [...list.children];
      assert.doesNotThrow(() => result({ ok: false, error: 'failed' }));
      result({ ok: true, line: 3 });
      assert.deepEqual(flashes(), []);
      assert.equal(sameChildren(list, before), true);
    });

    it('a second result for the same move is ignored', () => {
      const { list, initial } = moveWithClones();
      result({ ok: false, error: 'failed' });
      assert.equal(sameChildren(list, initial), true);
      result({ ok: false, error: 'failed' });
      assert.equal(flashes().length, 1, 'one message');
    });
  });

  // ---- payloads against the host --------------------------------------------------------------

  describe('payload accepted by the host', () => {
    interface Fixture {
      name: string;
      markdown: string;
      /** Which list of the document (document order, outer before inner). */
      list: number;
      /** Indent of this list's items in the source. */
      indent: string;
    }
    const NESTED = '- one\n  - x\n  - y\n  - z\n- two\n- three\n';
    const FIXTURES: Fixture[] = [
      { name: 'tight bullet list', markdown: '- a\n- b\n- c\n', list: 0, indent: '' },
      { name: 'loose bullet list', markdown: '- a\n\n- b\n\n- c\n', list: 0, indent: '' },
      { name: 'ordered list', markdown: '1. a\n2. b\n3. c\n', list: 0, indent: '' },
      { name: 'ordered list with ")" markers', markdown: '1) a\n2) b\n3) c\n', list: 0, indent: '' },
      { name: 'task list', markdown: '- [ ] a\n- [x] b\n- [ ] c\n', list: 0, indent: '' },
      { name: 'items with several lines and paragraphs', markdown: '- a\n  more a\n- b\n\n  para of b\n- c\n', list: 0, indent: '' },
      { name: 'list between paragraphs', markdown: 'intro\n\n- a\n- b\n- c\n\noutro\n', list: 0, indent: '' },
      { name: 'second of two lists', markdown: '- p\n- q\n\ntext\n\n- a\n- b\n- c\n', list: 1, indent: '' },
      { name: 'list with a nested list: the outer list', markdown: NESTED, list: 0, indent: '' },
      { name: 'list with a nested list: the inner list', markdown: NESTED, list: 1, indent: '  ' },
      { name: 'four items with a nested list at the end', markdown: '- a\n- b\n- c\n- d\n  - e\n  - f\n', list: 0, indent: '' },
    ];

    for (const fixture of FIXTURES) {
      it(`${fixture.name}: every one-step move is a payload the host accepts and matches the shown order`, () => {
        load(fixture.markdown);
        const count = items(lists()[fixture.list]).length;
        const expectedLabels = labels(lists()[fixture.list]);
        let tried = 0;
        for (let from = 0; from < count; from++) {
          for (const step of [-1, 1]) {
            const to = from + step;
            if (to < 0 || to >= count) continue;
            tried++;
            const context = `${fixture.name}: ${from} -> ${to}`;
            rerender(fixture.markdown);
            const list = lists()[fixture.list];
            flow(list);
            focusGripOn(items(list)[from]);
            vscode.clear();
            (step < 0 ? altUp : altDown)();
            const msg = onlyMove();
            assert.equal(msg.from, from, context);
            assert.equal(msg.to, to, context);
            assert.equal(msg.docVersion, 7, context);
            // The host takes it, and its result shows the items in the order the preview already has.
            const host = hostAccepts(msg);
            const shown = labels(list);
            const expectedOrder = [...expectedLabels];
            expectedOrder.splice(to, 0, ...expectedOrder.splice(from, 1));
            assert.deepEqual(shown, expectedOrder, context);
            assert.deepEqual(sourceLabels(host.source, msg, fixture.indent), shown, context);

            // After the host's render the grip is on the moved item, in its new place.
            rerender(host.source);
            const fresh = lists()[fixture.list];
            flow(fresh);
            result({ ok: true, line: host.line });
            const movedItem = content.querySelector(`li[data-item-end][data-line="${host.line}"]`);
            assert.ok(movedItem, context);
            assert.equal(label(movedItem), expectedLabels[from], context);
            assert.equal(grip.hidden, false, context);
            assert.equal(document.activeElement, grip, context);
            assert.equal(grip.style.top, `${movedItem.getBoundingClientRect().top}px`, context);
          }
        }
        assert.ok(tried >= 4, 'the fixture exercised several moves');
      });
    }

    it('moving an inner item cites the inner list only, moving an outer item cites the outer list (with its nested block)', () => {
      load(NESTED); // inner items at lines 1-3 (ends 2, 3, 4), outer at 0, 4, 5 (the last ends at 6)
      const [outer, inner] = lists();
      flow(outer, [80, 20, 20]);
      flow(inner, undefined, 120);

      focusGripOn(items(inner)[1]);
      altDown();
      assert.deepEqual(vscode.posted, [{ type: 'moveListItem', starts: [1, 2, 3], end: 4, from: 1, to: 2, docVersion: 7 }]);
      assert.equal(hostAccepts(onlyMove()).source, '- one\n  - x\n  - z\n  - y\n- two\n- three\n');
      result({ ok: true });
      vscode.clear();

      focusGripOn(items(outer)[0]);
      altDown();
      assert.deepEqual(vscode.posted, [{ type: 'moveListItem', starts: [0, 4, 5], end: 6, from: 0, to: 1, docVersion: 7 }]);
      assert.equal(hostAccepts(onlyMove()).source, '- two\n- one\n  - x\n  - y\n  - z\n- three\n');
    });

    it('dragging an inner item cites the inner list, with the outer item untouched', () => {
      load(NESTED);
      const [outer, inner] = lists();
      flow(outer, [80, 20, 20]);
      flow(inner, [30, 20, 30], 120); // x 120-150, y 150-170 (middle 160), z 170-200 (middle 185)
      const [x, y, z] = items(inner);
      dragBy(y, 160, 40);
      assert.deepEqual(items(inner), [x, z, y]);
      assert.deepEqual(onlyMove(), { type: 'moveListItem', starts: [1, 2, 3], end: 4, from: 1, to: 2, docVersion: 7 });
      assert.equal(labels(outer).join(), 'one,two,three');
    });

    it('moves a task item with its checkbox state', () => {
      load('- [ ] a\n- [x] b\n- [ ] c\n');
      const list = lists()[0];
      flow(list);
      const [, b] = items(list);
      focusGripOn(b);
      altDown();
      assert.deepEqual(items(list).map(label), ['a', 'c', 'b']);
      assert.equal(items(list)[2].querySelector<HTMLInputElement>('input')?.checked, true);
      assert.equal(hostAccepts(onlyMove()).source, '- [ ] a\n- [ ] c\n- [x] b\n');
    });

    it('renumbers an ordered list in the source while the preview keeps its own numbering', () => {
      load('1. first\n2. second\n3. third\n');
      const list = lists()[0];
      flow(list);
      focusGripOn(items(list)[0]);
      altDown();
      assert.equal(hostAccepts(onlyMove()).source, '1. second\n2. first\n3. third\n');
    });
  });
});
