import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUICK_SETTING_KEYS, type QuickSettingKey } from '../../src/protocol';
import { DEFAULTS, ENUM_SETTINGS, NUMBER_SETTINGS, validateQuickSetting } from '../../src/config/values';
import type { Control } from '../../webview/settingsPanel';
import { useDom } from './dom';
import { useVsCodeApi } from './vscodeApi';

// `src/config/settings.ts` re-exports `validateQuickSetting` but imports `vscode` at runtime, which mocha cannot load;
// the function itself lives in the pure `src/config/values.ts`, so the contract below runs the real validation.

type PanelModule = typeof import('../../webview/settingsPanel');

/**
 * Quick-setting keys with no control in the ⚙ panel, and why. A key listed here that gains a control (or
 * stops being a quick setting) fails the contract test, so the list cannot go stale.
 */
const NO_PANEL_CONTROL: Partial<Record<QuickSettingKey, string>> = {
  // The sidebar width is set by dragging the outline's resize handle (webview/navResize.ts posts `updateSetting`,
  // and '' on double-click to reset), not from the panel.
  'nav.width': 'set by dragging the outline resize handle (webview/navResize.ts)',
};

/** Host enum values that the panel deliberately does not offer: none today (every enum list is rendered through `labelled`). */
const ENUM_VALUES_NOT_OFFERED: Partial<Record<QuickSettingKey, readonly string[]>> = {};

/** Every value a slider can be at: min, min + step, ... max (rounded to dodge float noise, clamped like the browser). */
function sliderValues(c: { min: number; max: number; step: number }): number[] {
  const count = Math.round((c.max - c.min) / c.step);
  const values: number[] = [];
  for (let k = 0; k <= count; k++) values.push(Math.min(c.max, Number((c.min + k * c.step).toFixed(6))));
  return values;
}

describe('settings panel', () => {
  useDom({ globals: ['Option'] });
  const vscode = useVsCodeApi();
  let mod: PanelModule;
  let SECTIONS: PanelModule['SECTIONS'];
  let allControls: Control[];

  before(async () => {
    mod = await import('../../webview/settingsPanel');
    SECTIONS = mod.SECTIONS;
    allControls = SECTIONS.flatMap((s) => s.controls);
  });

  describe('contract with the host (QUICK_SETTING_KEYS, values.ts, validateQuickSetting)', () => {
    it('only has controls for quick settings, one control per key', () => {
      const keys = allControls.map((c) => c.key);
      for (const key of keys) assert.ok((QUICK_SETTING_KEYS as readonly string[]).includes(key), `${key} is not in QUICK_SETTING_KEYS`);
      assert.equal(new Set(keys).size, keys.length, 'a key has two controls');
    });

    it('has a control for every quick setting, except the documented ones', () => {
      const controlled = new Set<string>(allControls.map((c) => c.key));
      const missing = QUICK_SETTING_KEYS.filter((k) => !controlled.has(k) && !(k in NO_PANEL_CONTROL));
      assert.deepEqual(missing, [], 'quick settings without a panel control (add one, or document why not in NO_PANEL_CONTROL)');
      for (const key of Object.keys(NO_PANEL_CONTROL)) {
        assert.ok(!controlled.has(key), `${key} now has a control: remove it from NO_PANEL_CONTROL`);
        assert.ok((QUICK_SETTING_KEYS as readonly string[]).includes(key), `${key} is no longer a quick setting: remove it from NO_PANEL_CONTROL`);
      }
    });

    it('has unique, non-empty section ids and titles, and every section has controls', () => {
      const ids = SECTIONS.map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length);
      for (const s of SECTIONS) {
        assert.ok(s.id && s.title && s.icon, s.id);
        assert.ok(s.controls.length > 0, s.id);
      }
    });

    it('keeps every slider inside the host range, and the host accepts every value it can produce', () => {
      const ranges = allControls.filter((c): c is Extract<Control, { kind: 'range' }> => c.kind === 'range');
      assert.ok(ranges.length > 0);
      for (const c of ranges) {
        const limits = (NUMBER_SETTINGS as Record<string, { min: number; max: number; integer?: boolean }>)[c.key];
        assert.ok(limits, `${c.key} is a slider but has no entry in NUMBER_SETTINGS`);
        assert.ok(c.step > 0, `${c.key} step`);
        assert.ok(c.min < c.max, `${c.key} min < max`);
        assert.ok(c.min >= limits.min && c.max <= limits.max, `${c.key}: slider ${c.min}..${c.max} exceeds the host range ${limits.min}..${limits.max}`);
        const steps = (c.max - c.min) / c.step;
        assert.ok(Math.abs(steps - Math.round(steps)) < 1e-9, `${c.key}: max ${c.max} is not reachable from min ${c.min} in steps of ${c.step}`);
        if (limits.integer) assert.ok([c.min, c.max, c.step].every(Number.isInteger), `${c.key}: the host wants whole numbers`);
        for (const value of sliderValues(c)) {
          assert.equal(validateQuickSetting(c.key, value), value, `${c.key}: the host rejects ${value}, which the slider can produce`);
        }
        // The default must be representable, or the slider cannot show the effective setting.
        const dflt = (DEFAULTS as Record<string, unknown>)[c.key];
        assert.equal(typeof dflt, 'number', `${c.key} default`);
        assert.ok((dflt as number) >= c.min && (dflt as number) <= c.max, `${c.key}: default ${String(dflt)} is outside the slider range ${c.min}..${c.max}`);
        // The label formatter must cope with every value.
        for (const value of sliderValues(c)) assert.equal(typeof c.format(value), 'string');
      }
    });

    it('offers only values the host accepts in every select, and every host value of an enum', () => {
      const selects = allControls.filter((c): c is Extract<Control, { kind: 'select' }> => c.kind === 'select');
      assert.ok(selects.length > 0);
      for (const c of selects) {
        const produced = c.options.map(([value]) => (c.parse ? c.parse(value) : value));
        for (const value of produced) assert.equal(validateQuickSetting(c.key, value), value, `${c.key}: the host rejects the option ${String(value)}`);
        assert.equal(new Set(produced).size, produced.length, `${c.key}: duplicate option`);
        for (const [value, label] of c.options) assert.ok(label.length > 0, `${c.key}/${value}: empty label`);

        const hostEnum = (ENUM_SETTINGS as Record<string, readonly string[]>)[c.key];
        const hostNumber = (NUMBER_SETTINGS as Record<string, { min: number; max: number; integer?: boolean }>)[c.key];
        if (hostEnum) {
          const offered = new Set(produced);
          const allowed = ENUM_VALUES_NOT_OFFERED[c.key] ?? [];
          const notOffered = hostEnum.filter((v) => !offered.has(v) && !allowed.includes(v));
          assert.deepEqual(notOffered, [], `${c.key}: host values without an option`);
          for (const v of allowed) assert.ok(hostEnum.includes(v) && !offered.has(v), `${c.key}: stale allowlist entry ${v}`);
          for (const v of produced) assert.ok(hostEnum.includes(v as string), `${c.key}: ${String(v)} is not in the host enum`);
        } else {
          // A select over a numeric setting (navigation depth): every whole number of the host range is offered.
          assert.ok(hostNumber?.integer, `${c.key}: a select must be backed by an enum or a whole-number setting`);
          const expected = Array.from({ length: hostNumber.max - hostNumber.min + 1 }, (_, i) => hostNumber.min + i);
          assert.deepEqual([...(produced as number[])].sort((a, b) => a - b), expected, `${c.key}: options vs host range`);
          assert.ok(c.parse, `${c.key}: a numeric select must parse its option to a number`);
        }
      }
    });

    it('maps checkboxes to boolean settings and colors to color settings', () => {
      for (const c of allControls) {
        if (c.kind === 'checkbox') {
          assert.equal(typeof (DEFAULTS as Record<string, unknown>)[c.key], 'boolean', `${c.key} is not a boolean setting`);
          assert.equal(validateQuickSetting(c.key, true), true, c.key);
          assert.equal(validateQuickSetting(c.key, false), false, c.key);
          assert.equal(validateQuickSetting(c.key, 'true'), undefined, `${c.key} must not accept a string`);
        } else if (c.kind === 'color') {
          // The picker produces #rrggbb; '' (the "Default" button) removes the setting.
          assert.equal((DEFAULTS as Record<string, unknown>)[c.key], '', `${c.key} default`);
          assert.equal(validateQuickSetting(c.key, '#a1b2c3'), '#a1b2c3', c.key);
          assert.equal(validateQuickSetting(c.key, ''), '', c.key);
          assert.ok(c.cssVar.startsWith('--rm-'), c.key);
        }
      }
    });

    it('sets the preview CSS for inactive panels to visibility: hidden and for the active one to visible', () => {
      // The module only toggles the class; the hiding itself is CSS (jsdom has no cascade, so read the stylesheet).
      const css = readFileSync(join(process.cwd(), 'media', 'preview.css'), 'utf8');
      assert.match(css, /\.rm-settings-panel\s*\{[^}]*visibility:\s*hidden/);
      assert.match(css, /\.rm-settings-panel-active\s*\{[^}]*visibility:\s*visible/);
    });
  });

  describe('behavior (jsdom)', () => {
    let container: HTMLElement;
    let toggle: HTMLElement;

    /** Builds a fresh panel in the document. State seeded in `vscode.state` is read once, at build time. */
    function build(settingsTab?: string): void {
      if (settingsTab !== undefined) vscode.state = { uri: '', settingsTab };
      container = document.createElement('div');
      container.hidden = true;
      toggle = document.createElement('button');
      document.body.append(toggle, container);
      mod.initSettingsPanel(container, toggle);
    }
    const tabs = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const panels = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    const key = (tab: HTMLElement, name: string): KeyboardEvent => {
      const e = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
      tab.dispatchEvent(e);
      return e;
    };
    const selectedIndex = (): number[] => tabs().flatMap((t, i) => (t.getAttribute('aria-selected') === 'true' ? [i] : []));
    /** The row of the control `key`, found by its label like a reader would. */
    function row(key: QuickSettingKey): HTMLElement {
      const section = SECTIONS.findIndex((s) => s.controls.some((c) => c.key === key));
      const index = SECTIONS[section].controls.findIndex((c) => c.key === key);
      return panels()[section].children[index] as HTMLElement;
    }
    const fire = (el: Element, type: string): void => {
      el.dispatchEvent(new window.Event(type, { bubbles: true }));
    };

    describe('tabs', () => {
      it('has a tablist with one tab and one panel per section, wired by aria attributes', () => {
        build();
        const list = container.querySelector('[role="tablist"]');
        assert.ok(list);
        assert.equal(tabs().length, SECTIONS.length);
        assert.equal(panels().length, SECTIONS.length);
        SECTIONS.forEach((s, i) => {
          assert.equal(tabs()[i].getAttribute('aria-controls'), panels()[i].id);
          assert.equal(panels()[i].getAttribute('aria-labelledby'), tabs()[i].id);
          assert.equal(tabs()[i].getAttribute('aria-label'), s.title);
          assert.equal(tabs()[i].parentElement, list);
        });
      });

      it('starts on the first tab: exactly one panel is active, the others are inert', () => {
        build();
        assert.deepEqual(selectedIndex(), [0]);
        panels().forEach((p, i) => {
          assert.equal(p.classList.contains('rm-settings-panel-active'), i === 0, `panel ${i} class`);
          assert.equal(p.inert, i !== 0, `panel ${i} inert`);
        });
        tabs().forEach((t, i) => assert.equal(t.tabIndex, i === 0 ? 0 : -1, `tab ${i} tabindex`));
        assert.equal(container.querySelector('.rm-settings-tab-name')?.textContent, SECTIONS[0].title);
      });

      it('moves the selection and focus with the arrow keys, wrapping around, and saves the tab', () => {
        build();
        const last = SECTIONS.length - 1;
        const first = key(tabs()[0], 'ArrowRight');
        assert.equal(first.defaultPrevented, true);
        assert.deepEqual(selectedIndex(), [1]);
        assert.equal(document.activeElement, tabs()[1]);
        assert.equal(vscode.state?.settingsTab, SECTIONS[1].id);

        key(tabs()[1], 'ArrowLeft');
        assert.deepEqual(selectedIndex(), [0]);
        assert.equal(document.activeElement, tabs()[0]);

        key(tabs()[0], 'ArrowLeft'); // wraps to the last
        assert.deepEqual(selectedIndex(), [last]);
        assert.equal(document.activeElement, tabs()[last]);
        assert.equal(vscode.state?.settingsTab, SECTIONS[last].id);

        key(tabs()[last], 'ArrowRight'); // wraps to the first
        assert.deepEqual(selectedIndex(), [0]);
        assert.equal(document.activeElement, tabs()[0]);
      });

      it('jumps to the first and last tab with Home and End', () => {
        build();
        const last = SECTIONS.length - 1;
        key(tabs()[0], 'End');
        assert.deepEqual(selectedIndex(), [last]);
        assert.equal(document.activeElement, tabs()[last]);
        assert.equal(vscode.state?.settingsTab, SECTIONS[last].id);
        key(tabs()[last], 'Home');
        assert.deepEqual(selectedIndex(), [0]);
        assert.equal(document.activeElement, tabs()[0]);
        assert.equal(vscode.state?.settingsTab, SECTIONS[0].id);
      });

      it('keeps exactly one active panel (the rest inert) after every move', () => {
        build();
        for (const name of ['ArrowRight', 'ArrowRight', 'End', 'ArrowRight', 'Home', 'ArrowLeft']) {
          const from = selectedIndex()[0];
          key(tabs()[from], name);
          const now = selectedIndex();
          assert.equal(now.length, 1, name);
          assert.deepEqual(
            panels().flatMap((p, i) => (p.classList.contains('rm-settings-panel-active') ? [i] : [])),
            now,
            name,
          );
          assert.deepEqual(
            panels().flatMap((p, i) => (p.inert ? [] : [i])),
            now,
            `${name}: only the active panel is not inert`,
          );
          assert.deepEqual(
            tabs().flatMap((t, i) => (t.tabIndex === 0 ? [i] : [])),
            now,
            `${name}: only the selected tab is in the tab order`,
          );
          assert.equal(container.querySelector('.rm-settings-tab-name')?.textContent, SECTIONS[now[0]].title, name);
        }
      });

      it('ignores other keys', () => {
        build();
        for (const name of ['a', 'Enter', 'ArrowUp', 'ArrowDown', 'Tab']) {
          const e = key(tabs()[0], name);
          assert.equal(e.defaultPrevented, false, name);
        }
        assert.deepEqual(selectedIndex(), [0]);
        assert.equal(vscode.state, undefined);
      });

      it('selects a tab on click and saves it without taking focus', () => {
        build();
        tabs()[2].click();
        assert.deepEqual(selectedIndex(), [2]);
        assert.equal(panels()[2].inert, false);
        assert.equal(panels()[0].inert, true);
        assert.equal(vscode.state?.settingsTab, SECTIONS[2].id);
        assert.notEqual(document.activeElement, tabs()[2]);
      });

      it('restores the saved tab, and falls back to the first one for an unknown id', () => {
        const target = SECTIONS.length - 2;
        build(SECTIONS[target].id);
        assert.deepEqual(selectedIndex(), [target]);
        assert.equal(panels()[target].classList.contains('rm-settings-panel-active'), true);
        assert.equal(panels()[0].inert, true);

        build('no-such-tab');
        assert.deepEqual(selectedIndex(), [0]);
      });

      it('keeps the other state fields when it saves the tab', () => {
        vscode.state = { uri: 'file:///a.md', scrollLine: 12, collapsed: ['x'] };
        build();
        key(tabs()[0], 'ArrowRight');
        assert.equal(vscode.state?.settingsTab, SECTIONS[1].id);
        assert.equal(vscode.state?.scrollLine, 12);
        assert.deepEqual(vscode.state?.collapsed, ['x']);
      });
    });

    describe('controls post updateSetting', () => {
      beforeEach(() => build());

      it('posts a number for a slider on change, and updates the shown value on input', () => {
        const r = row('body.fontSize');
        const input = r.querySelector<HTMLInputElement>('input[type="range"]')!;
        assert.equal(input.min, '10');
        assert.equal(input.max, '28');
        assert.equal(input.step, '1');
        input.value = '20';
        fire(input, 'input');
        assert.equal(r.querySelector('.rm-settings-value')?.textContent, '20px');
        assert.deepEqual(vscode.posted, []); // nothing is written while dragging
        fire(input, 'change');
        assert.deepEqual(vscode.posted, [{ type: 'updateSetting', key: 'body.fontSize', value: 20 }]);
      });

      it('posts the fractional value of a slider with a fractional step', () => {
        const input = row('body.lineHeight').querySelector<HTMLInputElement>('input[type="range"]')!;
        input.value = '1.8';
        fire(input, 'change');
        assert.deepEqual(vscode.posted, [{ type: 'updateSetting', key: 'body.lineHeight', value: 1.8 }]);
      });

      it('posts the option value of an enum select', () => {
        const select = row('theme.preset').querySelector('select')!;
        select.value = 'sepia';
        fire(select, 'change');
        assert.deepEqual(vscode.posted, [{ type: 'updateSetting', key: 'theme.preset', value: 'sepia' }]);
      });

      it('posts a number for a select that parses its option', () => {
        const select = row('nav.maxDepth').querySelector('select')!;
        select.value = '4';
        fire(select, 'change');
        assert.deepEqual(vscode.posted, [{ type: 'updateSetting', key: 'nav.maxDepth', value: 4 }]);
      });

      it('posts a boolean for a checkbox', () => {
        const box = row('edit.enabled').querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        box.click();
        assert.deepEqual(vscode.posted, [{ type: 'updateSetting', key: 'edit.enabled', value: true }]);
        box.click();
        assert.deepEqual(vscode.postedOfType('updateSetting').map((m) => m.value), [true, false]);
      });

      it('posts the picked color on change, previewing it live on input', () => {
        const r = row('table.headerBackgroundColor');
        const input = r.querySelector<HTMLInputElement>('input[type="color"]')!;
        input.value = '#aabbcc';
        fire(input, 'input');
        assert.equal(document.documentElement.style.getPropertyValue('--rm-table-header-bg'), '#aabbcc');
        assert.deepEqual(vscode.posted, []);
        fire(input, 'change');
        assert.deepEqual(vscode.posted, [{ type: 'updateSetting', key: 'table.headerBackgroundColor', value: '#aabbcc' }]);
      });

      it('posts an empty string from the Default button, which removes the setting, and drops the live preview', () => {
        const r = row('table.headerTextColor');
        const input = r.querySelector<HTMLInputElement>('input[type="color"]')!;
        input.value = '#112233';
        fire(input, 'input');
        assert.equal(document.documentElement.style.getPropertyValue('--rm-table-header-fg'), '#112233');
        r.querySelector<HTMLButtonElement>('.rm-settings-reset')!.click();
        assert.equal(document.documentElement.style.getPropertyValue('--rm-table-header-fg'), '');
        assert.deepEqual(vscode.posted, [{ type: 'updateSetting', key: 'table.headerTextColor', value: '' }]);
        assert.equal(validateQuickSetting('table.headerTextColor', ''), '');
      });

      it('posts openSettings from the "All settings" button', () => {
        container.querySelector<HTMLButtonElement>('.rm-settings-more')!.click();
        assert.deepEqual(vscode.posted, [{ type: 'openSettings' }]);
      });

      it('writes values the host accepts for every control kind it can drive from the DOM', () => {
        // Whatever each control posts must pass the host's validation: option by option, slider ends, both checkbox states.
        for (const section of SECTIONS) {
          for (const control of section.controls) {
            const r = row(control.key);
            vscode.clear();
            if (control.kind === 'select') {
              const select = r.querySelector('select')!;
              for (const [value] of control.options) {
                vscode.clear();
                select.value = value;
                fire(select, 'change');
                const [msg] = vscode.postedOfType('updateSetting');
                assert.equal(msg.key, control.key);
                assert.notEqual(validateQuickSetting(msg.key, msg.value), undefined, `${control.key}=${String(msg.value)} rejected by the host`);
              }
            } else if (control.kind === 'range') {
              const input = r.querySelector<HTMLInputElement>('input[type="range"]')!;
              for (const v of [control.min, control.max]) {
                vscode.clear();
                input.value = String(v);
                fire(input, 'change');
                const [msg] = vscode.postedOfType('updateSetting');
                assert.equal(msg.key, control.key);
                assert.equal(msg.value, v);
                assert.notEqual(validateQuickSetting(msg.key, msg.value), undefined, `${control.key}=${String(v)} rejected by the host`);
              }
            } else if (control.kind === 'checkbox') {
              const box = r.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
              for (const expected of [true, false]) {
                vscode.clear();
                box.click();
                const [msg] = vscode.postedOfType('updateSetting');
                assert.equal(msg.value, expected);
                assert.notEqual(validateQuickSetting(msg.key, msg.value), undefined, `${control.key}=${String(expected)} rejected by the host`);
              }
            } else {
              const input = r.querySelector<HTMLInputElement>('input[type="color"]')!;
              input.value = '#0a0b0c';
              fire(input, 'change');
              r.querySelector<HTMLButtonElement>('.rm-settings-reset')!.click();
              const values = vscode.postedOfType('updateSetting').map((m) => m.value);
              assert.deepEqual(values, ['#0a0b0c', '']);
              for (const v of values) assert.notEqual(validateQuickSetting(control.key, v), undefined);
            }
          }
        }
      });
    });
  });
});
