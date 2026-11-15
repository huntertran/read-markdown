import * as assert from 'node:assert/strict';
import type { TableWidths } from '../../src/protocol';
import { createMarkdownRenderer } from '../../src/render/markdown';
import { useDom } from './dom';
import { useVsCodeApi } from './vscodeApi';

// tableResize.ts pulls in api.ts (acquireVsCodeApi at import), changes.ts and scroll.ts (window
// listeners at import), so it is loaded after the DOM and the host API stub exist.
//
// Not covered here (manual): real pointer capture and the click that follows a drag, the
// `elementFromPoint` hit-test against real layout (stubbed below), the hover class and the guide line,
// `lostpointercapture`, and how the frozen `colgroup`/`min-width` lay out in a real browser.
type TableResize = typeof import('../../webview/tableResize');

const SEP = '␟';
const render = createMarkdownRenderer();

/** The real renderer's HTML for a markdown table with the given header cells and one body row. */
function md(...header: string[]): string {
  const source = `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n| ${header.map((_, i) => `c${i}`).join(' | ')} |\n`;
  return render(source, { mermaid: true }).html;
}

/** Several tables, separated by paragraphs as in a real document. */
function doc(...tables: string[][]): string {
  return tables.map((t) => md(...t)).join('<p>text</p>');
}

describe('table column resize', () => {
  useDom();
  const vscode = useVsCodeApi();

  let mod: TableResize;
  let root: HTMLElement;
  /** What the pointer is over (stands in for `document.elementFromPoint`). */
  let under: Element | null = null;
  const captured: Element[] = [];

  before(async () => {
    mod = await import('../../webview/tableResize');
    Object.defineProperty(window.HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value(this: Element) {
        captured.push(this);
      },
    });
    document.elementFromPoint = () => under;
  });

  beforeEach(() => {
    mod.cancelTableResize();
    under = null;
    captured.length = 0;
    root = document.createElement('div');
    document.body.append(root);
    mod.initTableResize(root);
  });

  after(() => {
    mod.cancelTableResize();
  });

  // ---- helpers -----------------------------------------------------------------------------

  /** Replaces the preview content like a render does (new elements every time). */
  function mount(html: string): HTMLTableElement[] {
    root.innerHTML = html;
    return tables();
  }

  function tables(): HTMLTableElement[] {
    return [...root.querySelectorAll('table')];
  }

  function seed(...entries: TableWidths[]): void {
    vscode.state = { uri: '', tableWidths: entries };
  }

  function stored(): TableWidths[] | undefined {
    return vscode.state?.tableWidths;
  }

  function cols(table: HTMLTableElement): HTMLTableColElement[] {
    return [...table.querySelectorAll<HTMLTableColElement>(':scope > colgroup.rm-colgroup > col')];
  }

  function colWidths(table: HTMLTableElement): string[] {
    return cols(table).map((c) => c.style.width);
  }

  function colgroups(table: HTMLTableElement): number {
    return table.querySelectorAll(':scope > colgroup').length;
  }

  /** Gives every cell a rect: columns `widths` wide, rows stacked. */
  function layout(table: HTMLTableElement, widths: number[]): void {
    const total = widths.reduce((a, b) => a + b, 0);
    table.getBoundingClientRect = () => ({ left: 0, right: total, top: 0, bottom: 40, width: total, height: 40 }) as DOMRect;
    [...table.rows].forEach((row, r) => {
      let left = 0;
      [...row.cells].forEach((cell, c) => {
        const width = widths[c] ?? 0;
        const rect = { left, right: left + width, top: r * 20, bottom: r * 20 + 20, width, height: 20 } as DOMRect;
        cell.getBoundingClientRect = () => rect;
        left += width;
      });
    });
  }

  function pointer(type: string, target: Element, clientX: number, init: PointerEventInit = {}): Event {
    const e = new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX, pointerId: 1, button: 0, ...init });
    target.dispatchEvent(e);
    return e;
  }

  /** Drags the right border of `col` (row 0) by `dx`. */
  function dragBorder(table: HTMLTableElement, col: number, dx: number): void {
    const cell = table.rows[0].cells[col];
    const x = cell.getBoundingClientRect().right;
    under = cell;
    pointer('pointerdown', cell, x);
    pointer('pointermove', cell, x + dx, { buttons: 1 });
    pointer('pointerup', cell, x + dx);
  }

  function doubleClickBorder(table: HTMLTableElement, col: number): MouseEvent {
    const cell = table.rows[0].cells[col];
    under = cell;
    const e = new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: cell.getBoundingClientRect().right });
    cell.dispatchEvent(e);
    return e;
  }

  // ---- tableKeys ---------------------------------------------------------------------------

  describe('tableKeys', () => {
    it('is the header text with an occurrence index among tables with the same header', () => {
      const t = mount(doc(['A', 'B'], ['A', 'B'], ['C', 'D'], ['A', 'B']));
      assert.deepEqual(mod.tableKeys(t), [`A${SEP}B#0`, `A${SEP}B#1`, `C${SEP}D#0`, `A${SEP}B#2`]);
    });

    it('counts occurrences per header, not per document', () => {
      const t = mount(doc(['A'], ['B'], ['A'], ['B']));
      assert.deepEqual(mod.tableKeys(t), ['A#0', 'B#0', 'A#1', 'B#1']);
    });

    it('trims, collapses whitespace and flattens inline markup', () => {
      const t = mount(
        md('**Bold**   and   more', '`code`  x ') +
          md('Bold and more', 'code x') +
          '<table><tr><th>  Bold\n   and <em>more</em> </th><th>code   x</th></tr></table>',
      );
      assert.equal(t.length, 3);
      assert.deepEqual(mod.tableKeys(t), [`Bold and more${SEP}code x#0`, `Bold and more${SEP}code x#1`, `Bold and more${SEP}code x#2`]);
    });

    it('keeps cell boundaries, so different splits of the same words differ', () => {
      const t = mount(doc(['A', 'B C'], ['A B', 'C']));
      const [k1, k2] = mod.tableKeys(t);
      assert.notEqual(k1, k2);
      assert.equal(k1, `A${SEP}B C#0`);
      assert.equal(k2, `A B${SEP}C#0`);
    });

    it('ignores words shown as deleted and keeps inserted ones', () => {
      const [t] = mount('<table><tr><th>Name <del class="rm-del">old</del><ins class="rm-ins">new</ins></th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
      assert.deepEqual(mod.tableKeys([t]), [`Name new${SEP}B#0`]);
      // Same key as the table without the change marks.
      const [plain] = mount(md('Name new', 'B'));
      assert.deepEqual(mod.tableKeys([plain]), [`Name new${SEP}B#0`]);
    });

    it('uses the first row of a table without a header row', () => {
      const t = mount('<table><tbody><tr><td>x</td><td>y</td></tr><tr><td>1</td><td>2</td></tr></tbody></table>');
      assert.deepEqual(mod.tableKeys(t), [`x${SEP}y#0`]);
    });

    it('gives a table without rows an empty header', () => {
      const t = mount('<table></table><table></table>');
      assert.deepEqual(mod.tableKeys(t), ['#0', '#1']);
    });
  });

  // ---- applyTableWidths --------------------------------------------------------------------

  describe('applyTableWidths', () => {
    it('does nothing without saved widths', () => {
      const [t] = mount(md('A', 'B'));
      mod.applyTableWidths();
      assert.equal(colgroups(t), 0);
      assert.equal(t.classList.contains('rm-table-sized'), false);
      assert.equal(vscode.state, undefined);
    });

    it('applies the entry with the same key: colgroup, width and min-width per column, sized class', () => {
      seed({ key: `A${SEP}B#0`, index: 0, widths: [120, 240] });
      const [t] = mount(md('A', 'B'));
      mod.applyTableWidths();
      assert.equal(t.classList.contains('rm-table-sized'), true);
      assert.equal(colgroups(t), 1);
      assert.equal(t.firstElementChild, t.querySelector('colgroup'), 'the colgroup comes first');
      assert.deepEqual(colWidths(t), ['120px', '240px']);
      assert.deepEqual(cols(t).map((c) => c.style.minWidth), ['120px', '240px']);
    });

    it('does not add a second colgroup when applied again to the same table', () => {
      seed({ key: `A${SEP}B#0`, index: 0, widths: [120, 240] });
      const [t] = mount(md('A', 'B'));
      mod.applyTableWidths();
      mod.applyTableWidths();
      assert.equal(colgroups(t), 1);
      assert.equal(cols(t).length, 2);
    });

    it('rebuilds a stale colgroup of another column count', () => {
      seed({ key: `A${SEP}B${SEP}C#0`, index: 0, widths: [10, 20, 30] });
      const [t] = mount(md('A', 'B', 'C'));
      t.prepend(Object.assign(document.createElement('colgroup'), { className: 'rm-colgroup' }));
      t.querySelector('colgroup')!.append(document.createElement('col'), document.createElement('col'));
      mod.applyTableWidths();
      assert.equal(colgroups(t), 1);
      assert.deepEqual(colWidths(t), ['10px', '20px', '30px']);
    });

    it('keeps each width on its own table after a re-render (same key)', () => {
      seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] }, { key: `C${SEP}D#0`, index: 1, widths: [300, 400] });
      const t = mount(doc(['A', 'B'], ['C', 'D']));
      mod.applyTableWidths();
      assert.deepEqual(colWidths(t[0]), ['100px', '200px']);
      assert.deepEqual(colWidths(t[1]), ['300px', '400px']);
      assert.deepEqual(stored(), [
        { key: `A${SEP}B#0`, index: 0, widths: [100, 200] },
        { key: `C${SEP}D#0`, index: 1, widths: [300, 400] },
      ]);
    });

    it('follows the key when two tables swap places', () => {
      seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] }, { key: `C${SEP}D#0`, index: 1, widths: [300, 400] });
      const t = mount(doc(['C', 'D'], ['A', 'B']));
      mod.applyTableWidths();
      assert.deepEqual(colWidths(t[0]), ['300px', '400px']);
      assert.deepEqual(colWidths(t[1]), ['100px', '200px']);
    });

    it('follows the key when a table is inserted above', () => {
      seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] });
      const t = mount(doc(['X', 'Y'], ['A', 'B']));
      mod.applyTableWidths();
      assert.equal(cols(t[0]).length, 0, 'the new table has no widths');
      assert.equal(t[0].classList.contains('rm-table-sized'), false);
      assert.deepEqual(colWidths(t[1]), ['100px', '200px']);
    });

    it('tells apart tables with the same header by occurrence', () => {
      seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] }, { key: `A${SEP}B#1`, index: 1, widths: [300, 400] });
      const t = mount(doc(['A', 'B'], ['A', 'B']));
      mod.applyTableWidths();
      assert.deepEqual(colWidths(t[0]), ['100px', '200px']);
      assert.deepEqual(colWidths(t[1]), ['300px', '400px']);
      assert.deepEqual(
        stored()?.map((e) => e.key),
        [`A${SEP}B#0`, `A${SEP}B#1`],
        'both matched by key, nothing re-keyed',
      );
    });

    it('does not size the second table with the same header when only the first was saved', () => {
      seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] });
      const t = mount(doc(['A', 'B'], ['A', 'B']));
      mod.applyTableWidths();
      assert.deepEqual(colWidths(t[0]), ['100px', '200px']);
      assert.equal(cols(t[1]).length, 0);
    });

    describe('fallback to the table at the same position', () => {
      it('adopts an entry whose header changed, and re-keys it in the state', () => {
        seed({ key: `Old${SEP}B#0`, index: 0, widths: [111, 222] });
        const [t] = mount(md('New', 'B'));
        mod.applyTableWidths();
        assert.deepEqual(colWidths(t), ['111px', '222px']);
        assert.deepEqual(stored(), [{ key: `New${SEP}B#0`, index: 0, widths: [111, 222] }]);
      });

      it('adopts per position, leaving matched entries alone', () => {
        seed({ key: `Old${SEP}B#0`, index: 0, widths: [111, 222] }, { key: `C${SEP}D#0`, index: 1, widths: [333, 444] });
        const t = mount(doc(['New', 'B'], ['C', 'D']));
        mod.applyTableWidths();
        assert.deepEqual(colWidths(t[0]), ['111px', '222px']);
        assert.deepEqual(colWidths(t[1]), ['333px', '444px']);
        assert.deepEqual(stored(), [
          { key: `New${SEP}B#0`, index: 0, widths: [111, 222] },
          { key: `C${SEP}D#0`, index: 1, widths: [333, 444] },
        ]);
      });

      it('is a one-time adoption: the next render matches by the new key', () => {
        seed({ key: `Old${SEP}B#0`, index: 0, widths: [111, 222] });
        mount(md('New', 'B'));
        mod.applyTableWidths();
        const [again] = mount(md('New', 'B'));
        mod.applyTableWidths();
        assert.deepEqual(colWidths(again), ['111px', '222px']);
        assert.equal(stored()?.length, 1);
      });

      it('needs the same column count', () => {
        seed({ key: `Old${SEP}B${SEP}C#0`, index: 0, widths: [1, 2, 3] });
        const [t] = mount(md('New', 'B'));
        mod.applyTableWidths();
        assert.equal(cols(t).length, 0);
        assert.equal(t.classList.contains('rm-table-sized'), false);
        assert.deepEqual(stored(), [{ key: `Old${SEP}B${SEP}C#0`, index: 0, widths: [1, 2, 3] }], 'state untouched');
      });

      it('needs the same position', () => {
        seed({ key: `Old${SEP}B#0`, index: 1, widths: [111, 222] });
        const [t] = mount(md('New', 'B'));
        mod.applyTableWidths();
        assert.equal(cols(t).length, 0);
        assert.equal(stored()?.[0].key, `Old${SEP}B#0`);
      });

      it('does not give an entry to a second table', () => {
        seed({ key: `Old${SEP}B#0`, index: 0, widths: [111, 222] });
        const t = mount(doc(['New', 'B'], ['Other', 'B']));
        mod.applyTableWidths();
        assert.deepEqual(colWidths(t[0]), ['111px', '222px']);
        assert.equal(cols(t[1]).length, 0);
      });

      it('does not take an entry whose key belongs to another table of the document', () => {
        // The saved table now has another column count (spanning header), so it cannot use its
        // entry; the new 3-column table at its old position must not take it over either.
        seed({ key: 'A#0', index: 0, widths: [1, 2, 3] });
        const [x, a] = mount(md('X', 'Y', 'Z') + '<p>text</p><table><tr><th colspan="2">A</th></tr><tr><td>1</td><td>2</td></tr></table>');
        mod.applyTableWidths();
        assert.equal(cols(x).length, 0, 'X is not given the entry');
        assert.equal(cols(a).length, 0, 'A does not fit it (2 columns, 3 widths)');
      });

      it('takes the oldest unclaimed entry at that position', () => {
        seed({ key: `Gone${SEP}B#0`, index: 0, widths: [1, 2] }, { key: `Gone2${SEP}B#0`, index: 0, widths: [3, 4] });
        const [t] = mount(md('New', 'B'));
        mod.applyTableWidths();
        assert.deepEqual(colWidths(t), ['1px', '2px']);
        assert.deepEqual(stored(), [
          { key: `Gone2${SEP}B#0`, index: 0, widths: [3, 4] },
          { key: `New${SEP}B#0`, index: 0, widths: [1, 2] },
        ]);
      });
    });

    describe('column count', () => {
      it('ignores an entry with the same key but another column count', () => {
        // A header spanning all columns has the same text whatever the column count.
        seed({ key: 'A#0', index: 0, widths: [1, 2, 3] });
        const [t] = mount('<table><tr><th colspan="2">A</th></tr><tr><td>1</td><td>2</td></tr></table>');
        mod.applyTableWidths();
        assert.equal(cols(t).length, 0);
        assert.equal(t.classList.contains('rm-table-sized'), false);
      });

      it('counts colspans as columns', () => {
        seed({ key: 'A#0', index: 0, widths: [1, 2, 3] });
        const [three] = mount('<table><tr><th colspan="3">A</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>');
        mod.applyTableWidths();
        assert.deepEqual(colWidths(three), ['1px', '2px', '3px']);
      });
    });

    describe('skipped tables', () => {
      it('does not size or count tables with author columns', () => {
        seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] });
        const t = mount(
          '<table><colgroup><col></colgroup><tr><th>A</th><th>B</th></tr></table>' +
            '<table><col><tr><th>A</th><th>B</th></tr></table>' +
            md('A', 'B'),
        );
        mod.applyTableWidths();
        assert.equal(cols(t[0]).length, 0);
        assert.equal(cols(t[1]).length, 0);
        assert.equal(t[0].classList.contains('rm-table-sized'), false);
        assert.equal(t[1].classList.contains('rm-table-sized'), false);
        // The third table is the first resizable one: occurrence 0, position 0.
        assert.deepEqual(colWidths(t[2]), ['100px', '200px']);
      });

      it('does not mistake its own colgroup for an author colgroup', () => {
        seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] });
        const [t] = mount(md('A', 'B'));
        mod.applyTableWidths();
        mod.applyTableWidths();
        assert.deepEqual(colWidths(t), ['100px', '200px']);
      });

      it('does not size or count removed and moved-from clones', () => {
        seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] });
        root.innerHTML = `<div class="rm-chg-del">${md('A', 'B')}</div><div class="rm-chg-move-from">${md('A', 'B')}</div>${md('A', 'B')}`;
        const t = tables();
        mod.applyTableWidths();
        assert.equal(cols(t[0]).length, 0);
        assert.equal(cols(t[1]).length, 0);
        assert.deepEqual(colWidths(t[2]), ['100px', '200px'], 'the live table is occurrence 0');
      });

      it('leaves added and modified blocks alone', () => {
        seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] });
        root.innerHTML = `<div class="rm-chg-mod">${md('A', 'B')}</div>`;
        mod.applyTableWidths();
        assert.deepEqual(colWidths(tables()[0]), ['100px', '200px']);
      });

      it('ignores tables without columns', () => {
        seed({ key: '#0', index: 0, widths: [] });
        const [t] = mount('<table></table>');
        mod.applyTableWidths();
        assert.equal(colgroups(t), 0);
      });

      it('ignores a table outside the preview root', () => {
        seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] });
        const outside = document.createElement('div');
        outside.innerHTML = md('A', 'B');
        document.body.append(outside);
        mount(md('A', 'B'));
        mod.applyTableWidths();
        assert.equal(outside.querySelector('colgroup'), null);
      });
    });

    describe('after a reload', () => {
      it('reproduces the widths from the stored state in a fresh document', () => {
        const [first] = mount(doc(['A', 'B'], ['C', 'D']));
        layout(first, [100, 100]);
        dragBorder(first, 0, 60);
        const saved = stored();
        assert.ok(saved);

        // A reload: the webview starts again with the persisted state and new DOM.
        mod.cancelTableResize();
        root = document.createElement('div');
        document.body.replaceChildren(root);
        mod.initTableResize(root);
        const t = mount(doc(['A', 'B'], ['C', 'D']));
        mod.applyTableWidths();
        assert.deepEqual(colWidths(t[0]), ['160px', '100px']);
        assert.equal(cols(t[1]).length, 0);
        assert.deepEqual(stored(), saved);
      });
    });
  });

  // ---- drag, reset and the stored state ----------------------------------------------------

  describe('resizing', () => {
    it('the first drag freezes every column at its laid-out width and stores the result', () => {
      const [t] = mount(md('A', 'B', 'C'));
      layout(t, [80, 120, 200]);
      dragBorder(t, 1, 30);
      assert.equal(t.classList.contains('rm-table-sized'), true);
      assert.equal(colgroups(t), 1);
      assert.deepEqual(colWidths(t), ['80px', '150px', '200px']);
      assert.deepEqual(cols(t).map((c) => c.style.minWidth), ['80px', '150px', '200px']);
      assert.deepEqual(stored(), [{ key: `A${SEP}B${SEP}C#0`, index: 0, widths: [80, 150, 200] }]);
      assert.equal(document.body.classList.contains('rm-col-resizing'), false);
    });

    it('takes the pointer and stops the event before other handlers', () => {
      const [t] = mount(md('A', 'B'));
      layout(t, [100, 100]);
      let seen = false;
      t.addEventListener('pointerdown', () => (seen = true)); // where block editing listens: below the capturing root
      const cell = t.rows[0].cells[0];
      under = cell;
      const e = pointer('pointerdown', cell, 100);
      assert.equal(e.defaultPrevented, true);
      assert.equal(seen, false);
      assert.deepEqual(captured, [t]);
      assert.equal(document.body.classList.contains('rm-col-resizing'), true);
      pointer('pointerup', cell, 100);
    });

    it('grabs a border from either side', () => {
      const [t] = mount(md('A', 'B'));
      layout(t, [100, 100]);
      const right = t.rows[0].cells[1];
      under = right;
      pointer('pointerdown', right, 102); // 2px right of the border, in the second cell
      pointer('pointermove', right, 142, { buttons: 1 });
      pointer('pointerup', right, 142);
      assert.deepEqual(colWidths(t), ['140px', '100px']);
    });

    it('does not start away from a border', () => {
      const [t] = mount(md('A', 'B'));
      layout(t, [100, 100]);
      const cell = t.rows[0].cells[0];
      under = cell;
      const e = pointer('pointerdown', cell, 50);
      assert.equal(e.defaultPrevented, false);
      assert.equal(colgroups(t), 0);
      assert.equal(captured.length, 0);
    });

    it('does not grab the table outer edge on the left', () => {
      const [t] = mount(md('A', 'B'));
      layout(t, [100, 100]);
      const cell = t.rows[0].cells[0];
      under = cell;
      const e = pointer('pointerdown', cell, 1);
      assert.equal(e.defaultPrevented, false);
      assert.equal(colgroups(t), 0);
    });

    it('ignores other buttons', () => {
      const [t] = mount(md('A', 'B'));
      layout(t, [100, 100]);
      const cell = t.rows[0].cells[0];
      under = cell;
      const e = pointer('pointerdown', cell, 100, { button: 2 });
      assert.equal(e.defaultPrevented, false);
      assert.equal(colgroups(t), 0);
    });

    it('does not start when no row has one cell per column', () => {
      const [t] = mount('<table><tr><th colspan="2">A</th><th colspan="2">B</th></tr><tr><td colspan="4">x</td></tr></table>');
      layout(t, [100, 100]);
      const cell = t.rows[0].cells[0];
      under = cell;
      const e = pointer('pointerdown', cell, 100);
      assert.equal(e.defaultPrevented, false);
      assert.equal(colgroups(t), 0);
      assert.equal(t.classList.contains('rm-table-sized'), false);
    });

    it('stops shrinking at the minimum width', () => {
      const [t] = mount(md('A', 'B'));
      layout(t, [100, 100]);
      dragBorder(t, 0, -90);
      assert.deepEqual(colWidths(t), ['40px', '100px']);
      assert.equal(stored()?.[0].widths[0], 40);
    });

    it('a click on a border without moving does not pin an unsaved table', () => {
      const [t] = mount(md('A', 'B'));
      layout(t, [100, 100]);
      const cell = t.rows[0].cells[0];
      under = cell;
      pointer('pointerdown', cell, 100);
      assert.equal(t.classList.contains('rm-table-sized'), true, 'frozen while pressed');
      pointer('pointerup', cell, 100);
      assert.equal(t.classList.contains('rm-table-sized'), false);
      assert.equal(colgroups(t), 0);
      assert.equal(vscode.state, undefined, 'nothing stored');
    });

    it('a click on a border without moving keeps a saved table sized', () => {
      seed({ key: `A${SEP}B#0`, index: 0, widths: [120, 240] });
      const [t] = mount(md('A', 'B'));
      mod.applyTableWidths();
      layout(t, [120, 240]);
      const cell = t.rows[0].cells[0];
      under = cell;
      pointer('pointerdown', cell, 120);
      pointer('pointerup', cell, 120);
      assert.equal(t.classList.contains('rm-table-sized'), true);
      assert.deepEqual(colWidths(t), ['120px', '240px']);
    });

    it('resizing a re-applied table starts from the saved width', () => {
      seed({ key: `A${SEP}B#0`, index: 0, widths: [120, 240] });
      const [t] = mount(md('A', 'B'));
      mod.applyTableWidths();
      layout(t, [999, 999]); // layout is not consulted for a table that is already sized
      dragBorder(t, 0, 10);
      assert.deepEqual(colWidths(t), ['130px', '240px']);
      assert.deepEqual(stored(), [{ key: `A${SEP}B#0`, index: 0, widths: [130, 240] }]);
    });

    it('stores widths under the key of the resized table and keeps the others', () => {
      seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] }, { key: `C${SEP}D#0`, index: 1, widths: [300, 400] });
      const t = mount(doc(['A', 'B'], ['C', 'D']));
      mod.applyTableWidths();
      layout(t[1], [300, 400]);
      dragBorder(t[1], 1, 25);
      assert.deepEqual(stored(), [
        { key: `A${SEP}B#0`, index: 0, widths: [100, 200] },
        { key: `C${SEP}D#0`, index: 1, widths: [300, 425] },
      ]);
    });

    it('stores tables with the same header under their own occurrence', () => {
      const t = mount(doc(['A', 'B'], ['A', 'B']));
      layout(t[0], [100, 100]);
      layout(t[1], [100, 100]);
      dragBorder(t[1], 0, 20);
      dragBorder(t[0], 0, 50);
      assert.deepEqual(stored(), [
        { key: `A${SEP}B#0`, index: 0, widths: [150, 100] },
        { key: `A${SEP}B#1`, index: 1, widths: [120, 100] },
      ]);
    });

    it('skips removed clones when numbering the table it stores', () => {
      root.innerHTML = `<div class="rm-chg-del">${md('A', 'B')}</div>${md('A', 'B')}`;
      const live = tables()[1];
      layout(live, [100, 100]);
      dragBorder(live, 0, 10);
      assert.deepEqual(stored(), [{ key: `A${SEP}B#0`, index: 0, widths: [110, 100] }]);
    });

    describe('double-click', () => {
      it('gives the table back its automatic layout and removes only its entry', () => {
        seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] }, { key: `C${SEP}D#0`, index: 1, widths: [300, 400] });
        const t = mount(doc(['A', 'B'], ['C', 'D']));
        mod.applyTableWidths();
        layout(t[0], [100, 200]);
        doubleClickBorder(t[0], 0);
        assert.equal(colgroups(t[0]), 0);
        assert.equal(t[0].classList.contains('rm-table-sized'), false);
        assert.deepEqual(stored(), [{ key: `C${SEP}D#0`, index: 1, widths: [300, 400] }]);
        assert.deepEqual(colWidths(t[1]), ['300px', '400px'], 'the other table keeps its widths');
      });

      it('does not reach block editing or the default word selection', () => {
        seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] });
        const [t] = mount(md('A', 'B'));
        mod.applyTableWidths();
        layout(t, [100, 200]);
        let reached = false;
        root.addEventListener('dblclick', () => (reached = true));
        t.addEventListener('dblclick', () => (reached = true));
        const e = doubleClickBorder(t, 0);
        assert.equal(e.defaultPrevented, true);
        assert.equal(reached, false);
      });

      it('leaves a double-click inside a cell alone', () => {
        seed({ key: `A${SEP}B#0`, index: 0, widths: [100, 200] });
        const [t] = mount(md('A', 'B'));
        mod.applyTableWidths();
        layout(t, [100, 200]);
        const cell = t.rows[0].cells[0];
        under = cell;
        let reached = false;
        t.addEventListener('dblclick', () => (reached = true));
        const e = new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 50 });
        cell.dispatchEvent(e);
        assert.equal(reached, true);
        assert.equal(e.defaultPrevented, false);
        assert.equal(t.classList.contains('rm-table-sized'), true);
        assert.equal(stored()?.length, 1);
      });

      it('a drag after a reset stores a fresh entry', () => {
        const [t] = mount(md('A', 'B'));
        layout(t, [100, 100]);
        dragBorder(t, 0, 20);
        doubleClickBorder(t, 0);
        assert.deepEqual(stored(), []);
        dragBorder(t, 0, 5);
        assert.deepEqual(stored(), [{ key: `A${SEP}B#0`, index: 0, widths: [105, 100] }]);
      });
    });

    describe('entries for tables that are not in the document', () => {
      const MAX_STALE = 30;
      const stale = (n: number): TableWidths[] => Array.from({ length: n }, (_, i) => ({ key: `S${i}#0`, index: i + 5, widths: [i + 1, 1] }));

      function resizeLive(): void {
        const [t] = mount(md('A', 'B'));
        layout(t, [100, 100]);
        dragBorder(t, 0, 10);
      }

      it('are kept, before the current tables', () => {
        seed(...stale(3));
        resizeLive();
        assert.deepEqual(stored(), [...stale(3), { key: `A${SEP}B#0`, index: 0, widths: [110, 100] }]);
      });

      it(`are all kept up to ${MAX_STALE}`, () => {
        seed(...stale(MAX_STALE));
        resizeLive();
        const entries = stored() ?? [];
        assert.equal(entries.length, MAX_STALE + 1);
        assert.equal(entries[0].key, 'S0#0');
        assert.equal(entries[MAX_STALE - 1].key, `S${MAX_STALE - 1}#0`);
        assert.equal(entries[MAX_STALE].key, `A${SEP}B#0`);
      });

      it(`drop the oldest beyond ${MAX_STALE}`, () => {
        seed(...stale(MAX_STALE + 1));
        resizeLive();
        const entries = stored() ?? [];
        assert.equal(entries.length, MAX_STALE + 1);
        assert.equal(entries[0].key, 'S1#0', 'S0 was the oldest');
        assert.equal(entries[MAX_STALE - 1].key, `S${MAX_STALE}#0`);
        assert.equal(entries[MAX_STALE].key, `A${SEP}B#0`);
      });

      it('never count the current tables against the limit', () => {
        seed(...stale(MAX_STALE + 5));
        const t = mount(doc(['A', 'B'], ['C', 'D']));
        layout(t[0], [100, 100]);
        layout(t[1], [100, 100]);
        dragBorder(t[0], 0, 10);
        dragBorder(t[1], 0, 10);
        const entries = stored() ?? [];
        assert.equal(entries.length, MAX_STALE + 2);
        assert.deepEqual(
          entries.slice(-2).map((e) => e.key),
          [`A${SEP}B#0`, `C${SEP}D#0`],
        );
        assert.equal(entries[0].key, 'S5#0');
      });

      it('come back when their table returns', () => {
        seed({ key: `Z${SEP}Y#0`, index: 3, widths: [70, 80] });
        resizeLive();
        const [z] = mount(md('Z', 'Y'));
        mod.applyTableWidths();
        assert.deepEqual(colWidths(z), ['70px', '80px']);
      });
    });
  });
});
