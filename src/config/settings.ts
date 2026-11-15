import * as vscode from 'vscode';
import type { AutoOpen, ChangesMode, MermaidLook, MermaidTheme, NavPosition, UiConfig } from '../protocol';
import { type StyleSettings, schemeForPreset } from './styles';
import { DEFAULTS, headingMapOf, readBool, readEnum, readNumber, readString, stringArrayOr } from './values';

export { validateQuickSetting } from './values';

export const SECTION = 'readMarkdown';

export interface Settings extends StyleSettings {
  autoOpen: AutoOpen;
  scrollSync: boolean;
  navShow: boolean;
  navPosition: NavPosition;
  navMaxDepth: number;
  customCssInline: string;
  customCssFiles: string[];
  searchSyncSelection: boolean;
  searchCaseSensitive: boolean;
  searchMinLength: number;
  copyButton: boolean;
  mermaid: boolean;
  mermaidTheme: MermaidTheme;
  mermaidLook: MermaidLook;
  collapsible: boolean;
  startCollapsedBelowLevel: number;
  editEnabled: boolean;
  editDoubleClick: boolean;
  editSaveOnCommit: boolean;
  changesMode: ChangesMode;
  agentProgress: boolean;
  taskProgress: boolean;
  /** Host-only: it shapes the webview's Content-Security-Policy, so the webview never needs it. */
  allowRemoteContent: boolean;
}

/**
 * Reads every setting through the typed readers in `values.ts`: a hand-edited settings.json can hold
 * any JSON in any field, so nothing is taken from `get` on trust.
 */
export function getSettings(scope?: vscode.ConfigurationScope): Settings {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  const get = (key: keyof typeof DEFAULTS): unknown => c.get<unknown>(key);
  return {
    autoOpen: readEnum('preview.autoOpen', get('preview.autoOpen')),
    scrollSync: readBool('preview.scrollSync', get('preview.scrollSync')),
    navShow: readBool('nav.show', get('nav.show')),
    navPosition: readEnum('nav.position', get('nav.position')),
    navMaxDepth: readNumber('nav.maxDepth', get('nav.maxDepth')),
    navWidth: readNumber('nav.width', get('nav.width')),
    preset: readEnum('theme.preset', get('theme.preset')),
    bodyFontFamily: readString('body.fontFamily', get('body.fontFamily')),
    bodyFontSize: readNumber('body.fontSize', get('body.fontSize')),
    bodyLineHeight: readNumber('body.lineHeight', get('body.lineHeight')),
    bodyMaxWidth: readNumber('body.maxWidth', get('body.maxWidth')),
    bodyFullWidth: readBool('body.fullWidth', get('body.fullWidth')),
    bodyBackgroundColor: readString('body.backgroundColor', get('body.backgroundColor')),
    bodyTextColor: readString('body.textColor', get('body.textColor')),
    headingFontFamily: readString('headings.fontFamily', get('headings.fontFamily')),
    headingScale: readNumber('headings.scale', get('headings.scale')),
    headingFontSizes: headingMapOf(get('headings.fontSizes')),
    headingColors: headingMapOf(get('headings.colors')),
    headingHighlight: readEnum('headings.highlight', get('headings.highlight')),
    headingHighlightColor: readString('headings.highlightColor', get('headings.highlightColor')),
    customCssInline: readString('customCss.inline', get('customCss.inline')),
    customCssFiles: stringArrayOr(get('customCss.files'), DEFAULTS['customCss.files']),
    searchSyncSelection: readBool('search.syncSelection', get('search.syncSelection')),
    searchCaseSensitive: readBool('search.caseSensitive', get('search.caseSensitive')),
    searchMinLength: readNumber('search.minLength', get('search.minLength')),
    searchHighlightColor: readString('search.highlightColor', get('search.highlightColor')),
    searchCurrentHighlightColor: readString('search.currentHighlightColor', get('search.currentHighlightColor')),
    tableHeaderBackgroundColor: readString('table.headerBackgroundColor', get('table.headerBackgroundColor')),
    tableHeaderTextColor: readString('table.headerTextColor', get('table.headerTextColor')),
    copyButton: readBool('code.copyButton', get('code.copyButton')),
    mermaid: readBool('mermaid.enabled', get('mermaid.enabled')),
    mermaidTheme: readEnum('mermaid.theme', get('mermaid.theme')),
    mermaidLook: readEnum('mermaid.look', get('mermaid.look')),
    collapsible: readBool('sections.collapsible', get('sections.collapsible')),
    startCollapsedBelowLevel: readNumber('sections.startCollapsedBelowLevel', get('sections.startCollapsedBelowLevel')),
    editEnabled: readBool('edit.enabled', get('edit.enabled')),
    editDoubleClick: readBool('edit.doubleClick', get('edit.doubleClick')),
    editSaveOnCommit: readBool('edit.saveOnCommit', get('edit.saveOnCommit')),
    changesMode: readEnum('changes.mode', get('changes.mode')),
    agentProgress: readBool('tasks.agentProgress', get('tasks.agentProgress')),
    taskProgress: readBool('tasks.progress', get('tasks.progress')),
    allowRemoteContent: readBool('security.allowRemoteContent', get('security.allowRemoteContent')),
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
    mermaidTheme: s.mermaidTheme,
    mermaidLook: s.mermaidLook,
    collapsible: s.collapsible,
    startCollapsedBelowLevel: s.startCollapsedBelowLevel,
    scrollSync: s.scrollSync,
    fontSize: s.bodyFontSize,
    lineHeight: s.bodyLineHeight,
    maxWidth: s.bodyMaxWidth,
    fullWidth: s.bodyFullWidth,
    headingScale: s.headingScale,
    tableHeaderBackgroundColor: s.tableHeaderBackgroundColor,
    tableHeaderTextColor: s.tableHeaderTextColor,
    editable: s.editEnabled,
    editDoubleClick: s.editDoubleClick,
    changesMode: s.changesMode,
    agentProgress: s.agentProgress,
    taskProgress: s.taskProgress,
  };
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
