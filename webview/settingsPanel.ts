// Gear popover with the most common reading settings. Changes are written to VS Code settings by
// the extension, which then broadcasts the new config back to every preview.
import type { QuickSettingKey, UiConfig } from '../src/protocol';
import { post } from './api';

type Control =
  | { kind: 'select'; key: QuickSettingKey; label: string; options: [string, string][]; get: (c: UiConfig) => string; parse?: (v: string) => unknown }
  | { kind: 'range'; key: QuickSettingKey; label: string; min: number; max: number; step: number; get: (c: UiConfig) => number; format: (v: number) => string }
  | { kind: 'checkbox'; key: QuickSettingKey; label: string; get: (c: UiConfig) => boolean }
  /** `cssVar` is previewed live while picking; `probe` is the CSS property read from a sample cell for the default. */
  | { kind: 'color'; key: QuickSettingKey; label: string; cssVar: string; probe: 'backgroundColor' | 'color'; get: (c: UiConfig) => string };

const CONTROLS: Control[] = [
  {
    kind: 'select',
    key: 'theme.preset',
    label: 'Theme',
    options: [
      ['vscode', 'Follow VS Code'],
      ['light', 'Light'],
      ['dark', 'Dark'],
      ['sepia', 'Sepia'],
      ['high-contrast', 'High contrast'],
    ],
    get: (c) => c.preset,
  },
  { kind: 'range', key: 'body.fontSize', label: 'Font size', min: 10, max: 28, step: 1, get: (c) => c.fontSize, format: (v) => `${v}px` },
  { kind: 'range', key: 'body.lineHeight', label: 'Line height', min: 1.2, max: 2.4, step: 0.05, get: (c) => c.lineHeight, format: (v) => v.toFixed(2) },
  {
    kind: 'range',
    key: 'body.maxWidth',
    label: 'Content width',
    min: 0,
    max: 1600,
    step: 20,
    get: (c) => c.maxWidth,
    format: (v) => (v === 0 ? 'Full' : `${v}px`),
  },
  { kind: 'range', key: 'headings.scale', label: 'Heading size', min: 0.7, max: 1.6, step: 0.05, get: (c) => c.headingScale, format: (v) => `${Math.round(v * 100)}%` },
  {
    kind: 'select',
    key: 'headings.highlight',
    label: 'Heading style',
    options: [
      ['none', 'Plain'],
      ['underline', 'Underline'],
      ['background', 'Background'],
      ['leftBorder', 'Left border'],
    ],
    get: (c) => c.headingHighlight,
  },
  {
    kind: 'color',
    key: 'table.headerBackgroundColor',
    label: 'Table header background',
    cssVar: '--rm-table-header-bg',
    probe: 'backgroundColor',
    get: (c) => c.tableHeaderBackgroundColor,
  },
  {
    kind: 'color',
    key: 'table.headerTextColor',
    label: 'Table header text',
    cssVar: '--rm-table-header-fg',
    probe: 'color',
    get: (c) => c.tableHeaderTextColor,
  },
  { kind: 'checkbox', key: 'nav.show', label: 'Show quick navigation', get: (c) => c.navShow },
  {
    kind: 'select',
    key: 'nav.position',
    label: 'Navigation side',
    options: [
      ['left', 'Left'],
      ['right', 'Right'],
    ],
    get: (c) => c.navPosition,
  },
  {
    kind: 'select',
    key: 'nav.maxDepth',
    label: 'Navigation depth',
    options: ['1', '2', '3', '4', '5', '6'].map((v) => [v, `H1–H${v}`] as [string, string]),
    get: (c) => String(c.navMaxDepth),
    parse: Number,
  },
];

let panel: HTMLElement;
const updaters: ((c: UiConfig) => void)[] = [];

// A hidden header cell styled by preview.css, used to read the effective (theme default) colors.
let probeCell: HTMLElement | undefined;
function probe(prop: 'backgroundColor' | 'color'): string {
  if (!probeCell) {
    const host = document.createElement('div');
    host.className = 'rm-markdown';
    host.hidden = true;
    host.innerHTML = '<table><thead><tr><th></th></tr></thead></table>';
    document.body.append(host);
    probeCell = host.querySelector('th')!;
  }
  return getComputedStyle(probeCell)[prop];
}

/** Converts a computed color (rgb(), rgba() or color(srgb ...)) to #rrggbb for <input type=color>. */
function toHex(color: string): string {
  let rgb: number[] | undefined;
  const srgb = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/.exec(color);
  if (srgb) rgb = srgb.slice(1, 4).map((v) => Number(v) * 255);
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color);
  if (m) rgb = m.slice(1, 4).map(Number);
  if (!rgb) return '#000000';
  return '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

export function initSettingsPanel(container: HTMLElement, toggle: HTMLElement): void {
  panel = container;
  const title = document.createElement('div');
  title.className = 'rm-settings-title';
  title.textContent = 'Reading settings';
  panel.append(title);

  for (const control of CONTROLS) {
    // Not a <label> for colors: clicking the text would otherwise activate the "Default" button.
    const row = document.createElement(control.kind === 'color' ? 'div' : 'label');
    row.className = `rm-settings-row rm-settings-${control.kind}`;
    const name = document.createElement('span');
    name.className = 'rm-settings-label';
    name.textContent = control.label;

    if (control.kind === 'select') {
      const select = document.createElement('select');
      for (const [value, label] of control.options) select.append(new Option(label, value));
      select.addEventListener('change', () => post({ type: 'updateSetting', key: control.key, value: control.parse ? control.parse(select.value) : select.value }));
      updaters.push((c) => (select.value = control.get(c)));
      row.append(name, select);
    } else if (control.kind === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      const value = document.createElement('span');
      value.className = 'rm-settings-value';
      input.addEventListener('input', () => (value.textContent = control.format(Number(input.value))));
      input.addEventListener('change', () => post({ type: 'updateSetting', key: control.key, value: Number(input.value) }));
      updaters.push((c) => {
        if (document.activeElement === input) return;
        input.value = String(control.get(c));
        value.textContent = control.format(control.get(c));
      });
      const line = document.createElement('span');
      line.className = 'rm-settings-head';
      line.append(name, value);
      row.append(line, input);
    } else if (control.kind === 'color') {
      const input = document.createElement('input');
      input.type = 'color';
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'rm-settings-reset';
      reset.textContent = 'Default';
      reset.title = 'Use the theme color';
      const root = document.documentElement.style;
      // Live preview while dragging in the picker; the setting is written when the picker closes.
      input.addEventListener('input', () => root.setProperty(control.cssVar, input.value));
      input.addEventListener('change', () => post({ type: 'updateSetting', key: control.key, value: input.value }));
      reset.addEventListener('click', (e) => {
        e.preventDefault();
        root.removeProperty(control.cssVar);
        post({ type: 'updateSetting', key: control.key, value: '' });
      });
      updaters.push((c) => {
        root.removeProperty(control.cssVar);
        const custom = control.get(c);
        reset.hidden = !custom;
        // Read after the new CSS variables are applied so the default reflects the current theme.
        requestAnimationFrame(() => (input.value = toHex(probe(control.probe))));
      });
      const controls = document.createElement('span');
      controls.className = 'rm-settings-color-controls';
      controls.append(reset, input);
      row.append(name, controls);
    } else {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => post({ type: 'updateSetting', key: control.key, value: input.checked }));
      updaters.push((c) => (input.checked = control.get(c)));
      row.append(input, name);
    }
    panel.append(row);
  }

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'rm-settings-more';
  more.textContent = 'All settings (fonts, colors, custom CSS)…';
  more.addEventListener('click', () => post({ type: 'openSettings' }));
  panel.append(more);

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node)) panel.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') panel.hidden = true;
  });
}

export function updateSettingsPanel(config: UiConfig): void {
  updaters.forEach((u) => u(config));
}
