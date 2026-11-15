// Layout and host stand-ins for the list drag tests (jsdom has no layout, no pointer capture, no
// Web Animations and no `requestAnimationFrame`).
//
// `flowList` gives the items of a list rectangles that follow the DOM: an item's page top is the list's
// top plus the heights of the items before it, so reordering the DOM moves them, as it would in a
// browser. Heights are listed per child element in the initial DOM order. Track-changes copies
// (`.rm-chg-del`, `.rm-chg-move-from`) take space only while the list is not `.rm-list-reordering`,
// as in the stylesheet (they are `display: none` during a drag).
import { moveListItem } from '../../src/edit/listMove';
import type { FromWebview } from '../../src/protocol';

type MoveMessage = Extract<FromWebview, { type: 'moveListItem' }>;

export const LIST_LEFT = 50;
export const LIST_WIDTH = 300;

export interface FlowOptions {
  /** Page-relative top of the list. */
  top: number;
  /** Heights of the list's children, in their initial DOM order (clones included). */
  heights: readonly number[];
  /** Where the page is scrolled (`window.scrollY`); rectangles are viewport-relative. */
  scrollY: () => number;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

export function flowList(list: HTMLElement, options: FlowOptions): void {
  const children = [...list.children];
  assertLength(children.length, options.heights.length);
  const heightOf = new Map(children.map((c, i) => [c, options.heights[i]]));
  const used = (c: Element): number => (list.classList.contains('rm-list-reordering') && c.matches('.rm-chg-del, .rm-chg-move-from') ? 0 : (heightOf.get(c) ?? 0));
  for (const child of children) {
    child.getBoundingClientRect = () => {
      let top = options.top;
      for (const sibling of list.children) {
        if (sibling === child) break;
        top += used(sibling);
      }
      return rect(LIST_LEFT, top - options.scrollY(), LIST_WIDTH, used(child));
    };
  }
  list.getBoundingClientRect = () => {
    let total = 0;
    for (const c of list.children) total += used(c);
    return rect(LIST_LEFT, options.top - options.scrollY(), LIST_WIDTH, total);
  };
}

function assertLength(actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`flowList: list has ${actual} children but ${expected} heights were given`);
}

/** What the host does with a `moveListItem` message: the document text after the move, and the moved item's new line. */
export function applyMoveToSource(source: string, msg: MoveMessage): { source: string; line: number } {
  const all = source.split('\n');
  const first = msg.starts[0];
  const moved = moveListItem(all.slice(first, msg.end), msg.starts.map((s) => s - first), msg.from, msg.to);
  if (!moved) throw new Error('the host would reject this move (listMove returned undefined)');
  const lines = [...all.slice(0, first), ...moved.lines, ...all.slice(first + moved.count)];
  return { source: lines.join('\n'), line: first + moved.movedOffset };
}
