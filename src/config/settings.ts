import * as vscode from 'vscode';
import type { HeadingHighlight, QuickSettingKey, ThemePreset, UiConfig } from '../protocol';
import { QUICK_SETTING_KEYS } from '../protocol';
import { type HeadingMap, type StyleSettings, schemeForPreset } from './styles';

export const SECTION = 'readMarkdown';

export type AutoOpen = 'off' | 'beside' | 'active';

export interface Settings extends StyleSettings {
  replaceDefault: boolean;
  autoOpen: AutoOpen;
  scrollSync: boolean;
  navShow: boolean;
  navPosition: 'left' | 'right';
  navMaxDepth: number;
  customCssInline: string;
  customCssFiles: string[];
  searchSyncSelection: boolean;
  searchCaseSensitive: boolean;
  searchMinLength: number;
  copyButton: boolean;
  mermaid: boolean;
  collapsible: boolean;
  startCollapsedBelowLevel: number;
}

export function getSettings(scope?: vscode.ConfigurationScope): Settings {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  return {
    replaceDefault: c.get<boolean>('preview.replaceDefault', false),
    autoOpen: c.get<AutoOpen>('preview.autoOpen', 'off'),
    scrollSync: c.get<boolean>('preview.scrollSync', true),
    navShow: c.get<boolean>('nav.show', true),
    navPosition: c.get<'left' | 'right'>('nav.position', 'left'),
    navMaxDepth: c.get<number>('nav.maxDepth', 3),
    navWidth: c.get<number>('nav.width', 260),
    preset: c.get<ThemePreset>('theme.preset', 'vscode'),
    bodyFontFamily: c.get<string>('body.fontFamily', ''),
    bodyFontSize: c.get<number>('body.fontSize', 15),
    bodyLineHeight: c.get<number>('body.lineHeight', 1.65),
    bodyMaxWidth: c.get<number>('body.maxWidth', 860),
    bodyBackgroundColor: c.get<string>('body.backgroundColor', ''),
    bodyTextColor: c.get<string>('body.textColor', ''),
    headingFontFamily: c.get<string>('headings.fontFamily', ''),
    headingScale: c.get<number>('headings.scale', 1),
    headingFontSizes: c.get<HeadingMap>('headings.fontSizes', {}),
    headingColors: c.get<HeadingMap>('headings.colors', {}),
    headingHighlight: c.get<HeadingHighlight>('headings.highlight', 'underline'),
    headingHighlightColor: c.get<string>('headings.highlightColor', ''),
    customCssInline: c.get<string>('customCss.inline', ''),
    customCssFiles: c.get<string[]>('customCss.files', []),
    searchSyncSelection: c.get<boolean>('search.syncSelection', true),
    searchCaseSensitive: c.get<boolean>('search.caseSensitive', false),
    searchMinLength: c.get<number>('search.minLength', 2),
    searchHighlightColor: c.get<string>('search.highlightColor', ''),
    searchCurrentHighlightColor: c.get<string>('search.currentHighlightColor', ''),
    tableHeaderBackgroundColor: c.get<string>('table.headerBackgroundColor', ''),
    tableHeaderTextColor: c.get<string>('table.headerTextColor', ''),
    copyButton: c.get<boolean>('code.copyButton', true),
    mermaid: c.get<boolean>('mermaid.enabled', true),
    collapsible: c.get<boolean>('sections.collapsible', true),
    startCollapsedBelowLevel: c.get<number>('sections.startCollapsedBelowLevel', 0),
  };
}

export function toUiConfig(s: Settings): UiConfig {
  return {
    navShow: s.navShow,
    navPosition: s.navPosition,
    navMaxDepth: s.navMaxDepth,
    preset: s.preset,
    scheme: schemeForPreset(s.preset),
    headingHighlight: s.headingHighlight,
    copyButton: s.copyButton,
    mermaid: s.mermaid,
    collapsible: s.collapsible,
    startCollapsedBelowLevel: s.startCollapsedBelowLevel,
    scrollSync: s.scrollSync,
    fontSize: s.bodyFontSize,
    lineHeight: s.bodyLineHeight,
    maxWidth: s.bodyMaxWidth,
    headingScale: s.headingScale,
    tableHeaderBackgroundColor: s.tableHeaderBackgroundColor,
    tableHeaderTextColor: s.tableHeaderTextColor,
  };
}

const PRESETS: readonly string[] = ['vscode', 'light', 'dark', 'sepia', 'high-contrast'];
const HIGHLIGHTS: readonly string[] = ['none', 'underline', 'background', 'leftBorder'];

/** Validates a value coming from the webview quick panel. Returns undefined if invalid. */
export function validateQuickSetting(key: string, value: unknown): unknown {
  if (!(QUICK_SETTING_KEYS as readonly string[]).includes(key)) return undefined;
  const k = key as QuickSettingKey;
  const inRange = (min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
  switch (k) {
    case 'nav.show':
      return typeof value === 'boolean' ? value : undefined;
    case 'nav.position':
      return value === 'left' || value === 'right' ? value : undefined;
    case 'nav.maxDepth':
      return Number.isInteger(value) ? inRange(1, 6) : undefined;
    case 'nav.width':
      // '' resets to the default (double-click on the resize handle).
      return value === '' ? value : Number.isInteger(value) ? inRange(120, 600) : undefined;
    case 'theme.preset':
      return typeof value === 'string' && PRESETS.includes(value) ? value : undefined;
    case 'body.fontSize':
      return inRange(8, 40);
    case 'body.lineHeight':
      return inRange(1, 3);
    case 'body.maxWidth':
      return inRange(0, 4000);
    case 'headings.scale':
      return inRange(0.5, 3);
    case 'headings.highlight':
      return typeof value === 'string' && HIGHLIGHTS.includes(value) ? value : undefined;
    case 'table.headerBackgroundColor':
    case 'table.headerTextColor':
      // '' resets to the theme default; the color picker only produces #rrggbb.
      return value === '' || (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) ? value : undefined;
  }
}

/** Writes a setting to the most specific scope that already defines it (default: user settings). */
export async function updateSetting(key: string, value: unknown): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const info = c.inspect(key);
  let target = vscode.ConfigurationTarget.Global;
  if (info?.workspaceFolderValue !== undefined) target = vscode.ConfigurationTarget.WorkspaceFolder;
  else if (info?.workspaceValue !== undefined) target = vscode.ConfigurationTarget.Workspace;
  // An empty string means "back to default": remove the entry instead of writing "".
  await c.update(key, value === '' ? undefined : value, target);
}
