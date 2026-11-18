// Gear popover with the most common reading settings, grouped into icon tabs. Changes are
// written to VS Code settings by the extension, which then broadcasts the new config back to every preview.
import {
  CHANGES_MODES,
  HEADING_HIGHLIGHTS,
  MERMAID_LOOKS,
  MERMAID_THEMES,
  NAV_POSITIONS,
  THEME_PRESETS,
  type ChangesMode,
  type HeadingHighlight,
  type MermaidLook,
  type MermaidTheme,
  type NavPosition,
  type QuickSettingKey,
  type ThemePreset,
  type UiConfig,
} from '../src/protocol';
import { getState, patchState, post } from './api';
import { toHex } from './color';

/** Select options in the order of an enum list; a missing label is a compile error, not a drifted list. */
function labelled<T extends string>(values: readonly T[], labels: Record<T, string>): [string, string][] {
  return values.map((v) => [v, labels[v]]);
}

const PRESET_LABELS: Record<ThemePreset, string> = {
  vscode: 'Follow VS Code',
  light: 'Light',
  dark: 'Dark',
  sepia: 'Sepia',
  'high-contrast': 'High contrast',
};
const HIGHLIGHT_LABELS: Record<HeadingHighlight, string> = {
  none: 'Plain',
  underline: 'Underline',
  background: 'Background',
  leftBorder: 'Left border',
};
const NAV_POSITION_LABELS: Record<NavPosition, string> = { left: 'Left', right: 'Right' };
const MERMAID_THEME_LABELS: Record<MermaidTheme, string> = {
  auto: 'Match preview',
  default: 'Default / Dark',
  neo: 'Neo',
  redux: 'Redux',
  'redux-color': 'Redux color',
  base: 'Base (light only)',
  forest: 'Forest (light only)',
  neutral: 'Neutral (light only)',
};
const MERMAID_LOOK_LABELS: Record<MermaidLook, string> = { classic: 'Classic', neo: 'Neo', handDrawn: 'Hand-drawn' };
const CHANGES_MODE_LABELS: Record<ChangesMode, string> = { inline: 'Inline', gutter: 'Bars only', off: 'Off' };

export type Control =
  | { kind: 'select'; key: QuickSettingKey; label: string; options: [string, string][]; get: (c: UiConfig) => string; parse?: (v: string) => unknown }
  /** `disabled`: greyed out while true (e.g. width slider while filling the screen width). */
  | { kind: 'range'; key: QuickSettingKey; label: string; min: number; max: number; step: number; get: (c: UiConfig) => number; format: (v: number) => string; disabled?: (c: UiConfig) => boolean }
  /** `parent`: sub-option, indented and disabled while the parent checkbox is off. */
  | { kind: 'checkbox'; key: QuickSettingKey; label: string; get: (c: UiConfig) => boolean; parent?: (c: UiConfig) => boolean }
  /** `cssVar` is previewed live while picking; `probe` is the CSS property read from a sample cell for the default. */
  | { kind: 'color'; key: QuickSettingKey; label: string; cssVar: string; probe: 'backgroundColor' | 'color'; get: (c: UiConfig) => string };

export interface Section {
  /** Stable id, saved in `WebviewState.settingsTab` when its tab is selected. */
  id: string;
  title: string;
  /** Inner markup of a 16×16 stroked SVG icon for the tab. */
  icon: string;
  controls: Control[];
}

export const SECTIONS: Section[] = [
  {
    id: 'appearance',
    title: 'Appearance',
    icon: '<path d="M3 13 7 3h2l4 10M5 9h6"/>',
    controls: [
      {
        kind: 'select',
        key: 'theme.preset',
        label: 'Theme',
        options: labelled(THEME_PRESETS, PRESET_LABELS),
        get: (c) => c.preset,
      },
      { kind: 'range', key: 'body.fontSize', label: 'Font size', min: 10, max: 28, step: 1, get: (c) => c.fontSize, format: (v) => `${v}px` },
      { kind: 'range', key: 'body.lineHeight', label: 'Line height', min: 1.2, max: 2.4, step: 0.05, get: (c) => c.lineHeight, format: (v) => v.toFixed(2) },
      { kind: 'range', key: 'headings.scale', label: 'Heading size', min: 0.7, max: 1.6, step: 0.05, get: (c) => c.headingScale, format: (v) => `${Math.round(v * 100)}%` },
      {
        kind: 'select',
        key: 'headings.highlight',
        label: 'Heading style',
        options: labelled(HEADING_HIGHLIGHTS, HIGHLIGHT_LABELS),
        get: (c) => c.headingHighlight,
      },
    ],
  },
  {
    id: 'layout',
    title: 'Layout & navigation',
    icon: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M6 3v10"/>',
    controls: [
      {
        kind: 'range',
        key: 'body.maxWidth',
        label: 'Content width',
        min: 400,
        max: 1600,
        step: 20,
        get: (c) => c.maxWidth,
        format: (v) => (v === 0 ? 'Full' : `${v}px`),
        disabled: (c) => c.fullWidth,
      },
      { kind: 'checkbox', key: 'body.fullWidth', label: 'Fill screen width', get: (c) => c.fullWidth },
      { kind: 'checkbox', key: 'preview.lineNumbers', label: 'Show source line numbers', get: (c) => c.sourceLineNumbers },
      { kind: 'checkbox', key: 'code.lineNumbers', label: 'Line numbers in code blocks', get: (c) => c.codeLineNumbers },
      { kind: 'checkbox', key: 'nav.show', label: 'Show quick navigation', get: (c) => c.navShow },
      {
        kind: 'select',
        key: 'nav.position',
        label: 'Navigation side',
        options: labelled(NAV_POSITIONS, NAV_POSITION_LABELS),
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
    ],
  },
  {
    id: 'tables',
    title: 'Tables',
    icon: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 7h12M2 10h12M7 3v10"/>',
    controls: [
      {
        kind: 'color',
        key: 'table.headerBackgroundColor',
        label: 'Header background',
        cssVar: '--rm-table-header-bg',
        probe: 'backgroundColor',
        get: (c) => c.tableHeaderBackgroundColor,
      },
      {
        kind: 'color',
        key: 'table.headerTextColor',
        label: 'Header text',
        cssVar: '--rm-table-header-fg',
        probe: 'color',
        get: (c) => c.tableHeaderTextColor,
      },
    ],
  },
  {
    id: 'diagrams',
    title: 'Diagrams',
    icon: '<rect x="2" y="2" width="5" height="4" rx="1"/><rect x="9" y="10" width="5" height="4" rx="1"/><path d="M4.5 6v3.5a1 1 0 0 0 1 1H9"/>',
    controls: [
      {
        kind: 'select',
        key: 'mermaid.theme',
        label: 'Diagram theme',
        options: labelled(MERMAID_THEMES, MERMAID_THEME_LABELS),
        get: (c) => c.mermaidTheme,
      },
      {
        kind: 'select',
        key: 'mermaid.look',
        label: 'Diagram style',
        options: labelled(MERMAID_LOOKS, MERMAID_LOOK_LABELS),
        get: (c) => c.mermaidLook,
      },
    ],
  },
  {
    id: 'editing',
    title: 'Editing & changes',
    icon: '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3z"/>',
    controls: [
      { kind: 'checkbox', key: 'edit.enabled', label: 'Edit blocks in preview (✎)', get: (c) => c.editable },
      { kind: 'checkbox', key: 'edit.doubleClick', label: 'Double-click to edit', get: (c) => c.editDoubleClick, parent: (c) => c.editable },
      {
        kind: 'select',
        key: 'changes.mode',
        label: 'Changes vs git',
        options: labelled(CHANGES_MODES, CHANGES_MODE_LABELS),
        get: (c) => c.changesMode,
      },
    ],
  },
  {
    id: 'tasks',
    title: 'Task lists',
    icon: '<rect x="2" y="2.5" width="4" height="4" rx="0.5"/><path d="m2.8 4.5 1 1 1.6-2M8 4.5h6M2 10.5h4v4H2zM8 12.5h6"/>',
    controls: [
      { kind: 'checkbox', key: 'tasks.agentProgress', label: 'Show agent progress on task lists', get: (c) => c.agentProgress },
      { kind: 'checkbox', key: 'tasks.progress', label: 'Progress bar & outline counts', get: (c) => c.taskProgress, parent: (c) => c.agentProgress },
    ],
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

export function initSettingsPanel(container: HTMLElement, toggle: HTMLElement): void {
  panel = container;
  const title = document.createElement('div');
  title.className = 'rm-settings-title';
  title.textContent = 'Reading settings';
  panel.append(title);

  // Icon tabs, one per section. All tab panels share one grid cell (see preview.css), so the pane keeps
  // the height of the tallest section and does not jump when switching tabs.
  const tabList = document.createElement('div');
  tabList.className = 'rm-settings-tabs';
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'Setting groups');
  const tabName = document.createElement('div');
  tabName.className = 'rm-settings-tab-name';
  tabName.setAttribute('aria-hidden', 'true');
  const panels = document.createElement('div');
  panels.className = 'rm-settings-panels';

  const tabs: HTMLButtonElement[] = [];
  const tabPanels: HTMLElement[] = [];
  const select = (index: number, focus = false): void => {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tabPanels[i].classList.toggle('rm-settings-panel-active', selected);
      tabPanels[i].inert = !selected;
    });
    tabName.textContent = SECTIONS[index].title;
    if (focus) tabs[index].focus();
  };

  SECTIONS.forEach((section, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'rm-settings-tab';
    tab.id = `rm-settings-tab-${section.id}`;
    tab.title = section.title;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-label', section.title);
    tab.setAttribute('aria-controls', `rm-settings-panel-${section.id}`);
    tab.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${section.icon}</svg>`;
    tab.addEventListener('click', () => {
      select(index);
      patchState({ settingsTab: section.id });
    });
    tab.addEventListener('keydown', (e) => {
      const last = SECTIONS.length - 1;
      const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: last }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const target = next > last ? 0 : next < 0 ? last : next;
      select(target, true);
      patchState({ settingsTab: SECTIONS[target].id });
    });
    tabs.push(tab);
    tabList.append(tab);

    const tabPanel = document.createElement('div');
    tabPanel.className = 'rm-settings-panel';
    tabPanel.id = `rm-settings-panel-${section.id}`;
    tabPanel.setAttribute('role', 'tabpanel');
    tabPanel.setAttribute('aria-labelledby', tab.id);
    for (const control of section.controls) tabPanel.append(buildRow(control));
    tabPanels.push(tabPanel);
    panels.append(tabPanel);
  });
  panel.append(tabList, tabName, panels);
  select(Math.max(0, SECTIONS.findIndex((s) => s.id === getState().settingsTab)));

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

function buildRow(control: Control): HTMLElement {
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
    const disabled = control.disabled;
    updaters.push((c) => {
      if (disabled) {
        input.disabled = disabled(c);
        row.classList.toggle('rm-settings-disabled', input.disabled);
      }
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
    const parent = control.parent;
    if (parent) row.classList.add('rm-settings-sub');
    updaters.push((c) => {
      input.checked = control.get(c);
      if (parent) {
        input.disabled = !parent(c);
        row.classList.toggle('rm-settings-disabled', input.disabled);
      }
    });
    row.append(input, name);
  }
  return row;
}

export function updateSettingsPanel(config: UiConfig): void {
  updaters.forEach((u) => u(config));
}
