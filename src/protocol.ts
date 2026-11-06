// Messages exchanged between the extension host and the preview webview.
// This file is imported by both bundles, so it must stay free of runtime imports.

export interface Heading {
  level: number;
  text: string;
  slug: string;
  /** 0-based source line. */
  line: number;
}

export type ThemePreset = 'vscode' | 'light' | 'dark' | 'sepia' | 'high-contrast';
export type HeadingHighlight = 'none' | 'underline' | 'background' | 'leftBorder';

export interface UiConfig {
  navShow: boolean;
  navPosition: 'left' | 'right';
  navMaxDepth: number;
  preset: ThemePreset;
  /** Color scheme implied by the preset; 'auto' follows the VS Code theme. */
  scheme: 'auto' | 'light' | 'dark';
  headingHighlight: HeadingHighlight;
  copyButton: boolean;
  mermaid: boolean;
  collapsible: boolean;
  startCollapsedBelowLevel: number;
  scrollSync: boolean;
  // Values mirrored into the quick settings panel.
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  headingScale: number;
  /** Empty string = theme default. */
  tableHeaderBackgroundColor: string;
  tableHeaderTextColor: string;
}

/** Keys the webview quick panel may change (relative to `readMarkdown.`). */
export const QUICK_SETTING_KEYS = [
  'nav.show',
  'nav.position',
  'nav.maxDepth',
  'nav.width',
  'theme.preset',
  'body.fontSize',
  'body.lineHeight',
  'body.maxWidth',
  'headings.scale',
  'headings.highlight',
  'table.headerBackgroundColor',
  'table.headerTextColor',
] as const;
export type QuickSettingKey = (typeof QUICK_SETTING_KEYS)[number];

export type ToWebview =
  | { type: 'render'; html: string; headings: Heading[]; hasMermaid: boolean; docVersion: number }
  | { type: 'config'; css: string; customCss: string; ui: UiConfig }
  | { type: 'highlight'; term: string; caseSensitive: boolean; blockLine: number; occurrence: number }
  | { type: 'scrollToLine'; line: number }
  | { type: 'revealHeading'; slug: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'revealLine'; line: number }
  | { type: 'openLink'; href: string }
  | { type: 'updateSetting'; key: QuickSettingKey; value: unknown }
  | { type: 'openSettings' }
  | { type: 'copy'; text: string }
  | { type: 'showSource'; line?: number };

export interface WebviewState {
  uri: string;
  scrollLine?: number;
  collapsed?: string[];
}
