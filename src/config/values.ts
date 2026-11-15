// The one place that knows every setting's default, enum list and numeric range, and how to read a
// raw value of it safely. Pure (no `vscode`) so `test/unit` can run it. `getSettings` reads with
// these and `validateQuickSetting` accepts with these, so a value the quick panel may write is
// always one `getSettings` returns unchanged. package.json declares the same defaults, enums and
// bounds for VS Code's settings UI; test/unit/settingsValues.test.ts keeps all of them equal.
import {
  AUTO_OPEN_MODES,
  CHANGES_MODES,
  HEADING_HIGHLIGHTS,
  MERMAID_LOOKS,
  MERMAID_THEMES,
  NAV_POSITIONS,
  QUICK_SETTING_KEYS,
  THEME_PRESETS,
  type QuickSettingKey,
} from '../protocol';
import type { HeadingMap } from './styles';

/** Defaults of every setting `getSettings` reads, by key relative to `readMarkdown.`. */
export const DEFAULTS = {
  'preview.autoOpen': 'off',
  'preview.scrollSync': true,
  'nav.show': true,
  'nav.position': 'left',
  'nav.maxDepth': 3,
  'nav.width': 260,
  'theme.preset': 'vscode',
  'body.fontFamily': '',
  'body.fontSize': 15,
  'body.lineHeight': 1.65,
  'body.maxWidth': 860,
  'body.fullWidth': false,
  'body.backgroundColor': '',
  'body.textColor': '',
  'headings.fontFamily': '',
  'headings.scale': 1,
  'headings.fontSizes': {},
  'headings.colors': {},
  'headings.highlight': 'underline',
  'headings.highlightColor': '',
  'customCss.inline': '',
  'customCss.files': [],
  'search.syncSelection': true,
  'search.caseSensitive': false,
  'search.minLength': 2,
  'search.highlightColor': '',
  'search.currentHighlightColor': '',
  'table.headerBackgroundColor': '',
  'table.headerTextColor': '',
  'code.copyButton': true,
  'mermaid.enabled': true,
  'mermaid.theme': 'auto',
  'mermaid.look': 'classic',
  'sections.collapsible': true,
  'sections.startCollapsedBelowLevel': 0,
  'edit.enabled': false,
  'edit.doubleClick': false,
  'edit.saveOnCommit': false,
  'changes.mode': 'inline',
  'tasks.agentProgress': true,
  'tasks.progress': true,
  'security.allowRemoteContent': true,
} as const;

/** Enum settings and their allowed values (the lists live in protocol.ts). */
export const ENUM_SETTINGS = {
  'preview.autoOpen': AUTO_OPEN_MODES,
  'nav.position': NAV_POSITIONS,
  'theme.preset': THEME_PRESETS,
  'headings.highlight': HEADING_HIGHLIGHTS,
  'changes.mode': CHANGES_MODES,
  'mermaid.theme': MERMAID_THEMES,
  'mermaid.look': MERMAID_LOOKS,
} as const;

export interface NumberLimits {
  min: number;
  max: number;
  /** Whole numbers only. */
  integer?: boolean;
}

/**
 * Numeric settings and their bounds: `minimum`/`maximum` from package.json. Where package.json
 * declares no upper bound (`body.maxWidth`, `search.minLength`) the cap is a sane one;
 * `body.maxWidth` uses the quick panel's.
 */
export const NUMBER_SETTINGS = {
  'nav.maxDepth': { min: 1, max: 6, integer: true },
  'nav.width': { min: 120, max: 600, integer: true },
  'body.fontSize': { min: 8, max: 40 },
  'body.lineHeight': { min: 1, max: 3 },
  'body.maxWidth': { min: 0, max: 4000, integer: true },
  'headings.scale': { min: 0.5, max: 3 },
  'search.minLength': { min: 1, max: 1000, integer: true },
  'sections.startCollapsedBelowLevel': { min: 0, max: 6, integer: true },
} as const satisfies Record<string, NumberLimits>;

export type EnumSettingKey = keyof typeof ENUM_SETTINGS;
export type NumberSettingKey = keyof typeof NUMBER_SETTINGS;
type EnumValue<K extends EnumSettingKey> = (typeof ENUM_SETTINGS)[K][number];
type KeysWhere<V> = { [K in keyof typeof DEFAULTS]: (typeof DEFAULTS)[K] extends V ? K : never }[keyof typeof DEFAULTS];
export type BooleanSettingKey = KeysWhere<boolean>;
export type StringSettingKey = Exclude<KeysWhere<string>, EnumSettingKey>;

const HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value` if it is one of `allowed` (hand-edited settings.json may hold anything), else `fallback`. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** True for a finite number inside `limits` (and whole, if the limits say so): what the quick panel may write. */
export function isWithinLimits(value: unknown, limits: NumberLimits): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= limits.min && value <= limits.max && (!limits.integer || Number.isInteger(value));
}

/**
 * `value` pulled into `limits` (rounded first if the limits ask for whole numbers). Anything that is
 * not a finite number, numeric strings included, gives `fallback`.
 */
export function clampNumber(value: unknown, limits: NumberLimits, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = limits.integer ? Math.round(value) : value;
  return Math.min(limits.max, Math.max(limits.min, n));
}

export function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** The strings of an array; a non-array gives a copy of `fallback`, other entries are dropped. */
export function stringArrayOr(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [...fallback];
}

/** Per-level CSS values (`h1`..`h6`); anything that is not a string for one of those keys is dropped. */
export function headingMapOf(value: unknown): HeadingMap {
  const out: HeadingMap = {};
  if (!isRecord(value)) return out;
  for (const level of HEADING_LEVELS) {
    const v = value[level];
    if (typeof v === 'string') out[level] = v;
  }
  return out;
}

export function readEnum<K extends EnumSettingKey>(key: K, value: unknown): EnumValue<K> {
  return oneOf(value, ENUM_SETTINGS[key] as readonly EnumValue<K>[], DEFAULTS[key] as EnumValue<K>);
}

export function readNumber(key: NumberSettingKey, value: unknown): number {
  return clampNumber(value, NUMBER_SETTINGS[key], DEFAULTS[key]);
}

export function readBool(key: BooleanSettingKey, value: unknown): boolean {
  return boolOr(value, DEFAULTS[key]);
}

export function readString(key: StringSettingKey, value: unknown): string {
  return stringOr(value, DEFAULTS[key]);
}

const isEnumKey = (key: string): key is EnumSettingKey => Object.hasOwn(ENUM_SETTINGS, key);
const isNumberKey = (key: string): key is NumberSettingKey => Object.hasOwn(NUMBER_SETTINGS, key);

/** Validates a value coming from the webview quick panel. Returns undefined if invalid. */
export function validateQuickSetting(key: string, value: unknown): unknown {
  if (!(QUICK_SETTING_KEYS as readonly string[]).includes(key)) return undefined;
  const k = key as QuickSettingKey;
  if (isEnumKey(k)) return typeof value === 'string' && (ENUM_SETTINGS[k] as readonly string[]).includes(value) ? value : undefined;
  if (isNumberKey(k)) {
    // '' resets nav.width to the default (double-click on the resize handle).
    if (k === 'nav.width' && value === '') return value;
    return isWithinLimits(value, NUMBER_SETTINGS[k]) ? value : undefined;
  }
  switch (k) {
    case 'nav.show':
    case 'body.fullWidth':
    case 'edit.enabled':
    case 'edit.doubleClick':
    case 'tasks.agentProgress':
    case 'tasks.progress':
      return typeof value === 'boolean' ? value : undefined;
    case 'table.headerBackgroundColor':
    case 'table.headerTextColor':
      // '' resets to the theme default; the color picker only produces #rrggbb.
      return value === '' || (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) ? value : undefined;
  }
}
