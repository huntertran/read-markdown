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
  /** In-preview block editing (`readMarkdown.edit.enabled`). */
  editable: boolean;
  /** Double-click opens a block for editing (`readMarkdown.edit.doubleClick`); only acts when `editable`. */
  editDoubleClick: boolean;
  /** How changes against the git index are shown (`readMarkdown.changes.mode`). */
  changesMode: ChangesMode;
  /** In-progress task items, follow and "just done" flash (`readMarkdown.tasks.agentProgress`). */
  agentProgress: boolean;
  /** Task progress bar and outline counts (`readMarkdown.tasks.progress`); only with `agentProgress`. */
  taskProgress: boolean;
}

export type ChangesMode = 'inline' | 'gutter' | 'off';

/**
 * One changed top-level block, by 0-based source line: `line` in the current document, `oldLine`
 * in the original (git index) version. `before` = line of the current block a removed block is
 * shown in front of (`null` = at the end). Unchanged blocks have no entry.
 */
export type BlockChange =
  | { op: 'ins'; line: number }
  | { op: 'del'; oldLine: number; before: number | null }
  | { op: 'modify'; oldLine: number; line: number }
  | { op: 'moveFrom'; oldLine: number; before: number | null; id: number }
  | { op: 'moveTo'; oldLine: number; line: number; id: number; edited: boolean };

/** Changes of the rendered document against its git index version. */
export interface DocChanges {
  /** The original version rendered like the current one (same `data-line` stamping). */
  originalHtml: string;
  ops: BlockChange[];
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
  'edit.enabled',
  'edit.doubleClick',
  'changes.mode',
  'tasks.agentProgress',
  'tasks.progress',
] as const;
export type QuickSettingKey = (typeof QUICK_SETTING_KEYS)[number];

export type ToWebview =
  | { type: 'render'; html: string; headings: Heading[]; hasMermaid: boolean; docVersion: number; changes?: DocChanges }
  | { type: 'config'; css: string; customCss: string; ui: UiConfig }
  | { type: 'highlight'; term: string; caseSensitive: boolean; blockLine: number; occurrence: number }
  | { type: 'scrollToLine'; line: number }
  | { type: 'revealHeading'; slug: string }
  /** Reply to `requestBlockSource`: source of lines [start, end) with LF line endings, no trailing line breaks. */
  | { type: 'blockSource'; start: number; end: number; docVersion: number; text?: string; error?: EditError }
  /** Reply to `editBlock`. */
  | { type: 'editResult'; start: number; end: number; ok: boolean; error?: EditError }
  /** Reply to `toggleTask`. */
  | { type: 'taskResult'; line: number; ok: boolean; error?: EditError }
  /** Switch this preview between inline track changes and gutter bars (`readMarkdown.toggleChanges`). */
  | { type: 'toggleChanges' }
  /** Open the top-level block starting at source `line` for editing (preview context menu). */
  | { type: 'startEdit'; line: number }
  /** Reply to `moveListItem`; `line` is the moved item's new start line. */
  | { type: 'moveResult'; ok: boolean; line?: number; error?: EditError };

/**
 * Why a block edit was refused: `stale` = the document changed since the preview was rendered,
 * `readonly` = the document's file system is not writable, `invalid` = bad line range,
 * `failed` = VS Code rejected the edit.
 */
export type EditError = 'stale' | 'readonly' | 'invalid' | 'failed';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'revealLine'; line: number }
  | { type: 'openLink'; href: string }
  | { type: 'updateSetting'; key: QuickSettingKey; value: unknown }
  | { type: 'openSettings' }
  | { type: 'copy'; text: string }
  | { type: 'showSource'; line?: number }
  /** Ask for the source of top-level block lines [start, end) as rendered at `docVersion`. */
  | { type: 'requestBlockSource'; start: number; end: number; docVersion: number }
  /** Replace source lines [start, end) with `text`, if the document is still at `docVersion`. */
  | { type: 'editBlock'; start: number; end: number; docVersion: number; text: string }
  /** Check or uncheck the task list item on source `line`, if the document is still at `docVersion`. */
  | { type: 'toggleTask'; line: number; checked: boolean; docVersion: number }
  /**
   * Move list item `from` to position `to` among sibling items starting at source lines `starts`
   * (the last ending at `end`, exclusive), if the document is still at `docVersion`.
   */
  | { type: 'moveListItem'; starts: number[]; end: number; from: number; to: number; docVersion: number };

/**
 * `data-vscode-context` the webview sets, merged by VS Code from the right-clicked element up to
 * `<body>` and passed to `webview/context` menu commands: `rmEditable` on the body, the rest on
 * each top-level block.
 */
export interface BlockMenuContext {
  webviewSection?: 'rm-block';
  /** 0-based source line where the block starts. */
  rmLine?: number;
  rmEditable?: boolean;
}

export interface WebviewState {
  uri: string;
  scrollLine?: number;
  collapsed?: string[];
  /** This preview's override of `readMarkdown.changes.mode` (toolbar toggle). */
  changesMode?: 'inline' | 'gutter';
  /** Scroll to task items as they become in progress (toolbar toggle); undefined = on. */
  followTasks?: boolean;
}
