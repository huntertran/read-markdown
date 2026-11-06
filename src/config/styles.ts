// Pure: converts settings into the CSS variable block consumed by media/preview.css.
import type { HeadingHighlight, ThemePreset } from '../protocol';

export type HeadingMap = Partial<Record<'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', string>>;

export interface StyleSettings {
  preset: ThemePreset;
  bodyFontFamily: string;
  bodyFontSize: number;
  bodyLineHeight: number;
  bodyMaxWidth: number;
  bodyBackgroundColor: string;
  bodyTextColor: string;
  headingFontFamily: string;
  headingScale: number;
  headingFontSizes: HeadingMap;
  headingColors: HeadingMap;
  headingHighlight: HeadingHighlight;
  headingHighlightColor: string;
  searchHighlightColor: string;
  searchCurrentHighlightColor: string;
  tableHeaderBackgroundColor: string;
  tableHeaderTextColor: string;
  navWidth: number;
}

interface Palette {
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  border: string;
  codeBg: string;
  /** Inline code text. Must be set explicitly: VS Code's webview CSS colors `code` from the VS Code theme. */
  codeFg: string;
  link: string;
  navBg: string;
  search: string;
  searchCurrent: string;
}

const PRESETS: Record<ThemePreset, Palette> = {
  vscode: {
    bg: 'var(--vscode-editor-background)',
    fg: 'var(--vscode-editor-foreground)',
    muted: 'var(--vscode-descriptionForeground)',
    accent: 'var(--vscode-textLink-foreground)',
    border: 'var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.35))',
    codeBg: 'var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12))',
    codeFg: 'var(--vscode-textPreformat-foreground, var(--rm-fg))',
    link: 'var(--vscode-textLink-foreground)',
    navBg: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
    search: 'var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33))',
    searchCurrent: 'var(--vscode-editor-findMatchBackground, rgba(255, 150, 50, 0.7))',
  },
  light: {
    bg: '#ffffff',
    fg: '#1f2328',
    muted: '#59636e',
    accent: '#0969da',
    border: '#d1d9e0',
    codeBg: '#f6f8fa',
    codeFg: 'var(--rm-fg)',
    link: '#0969da',
    navBg: '#f6f8fa',
    search: 'rgba(255, 212, 0, 0.45)',
    searchCurrent: 'rgba(255, 140, 0, 0.75)',
  },
  dark: {
    bg: '#0d1117',
    fg: '#e6edf3',
    muted: '#9198a1',
    accent: '#4493f8',
    border: '#3d444d',
    codeBg: '#151b23',
    codeFg: 'var(--rm-fg)',
    link: '#4493f8',
    navBg: '#010409',
    search: 'rgba(187, 128, 9, 0.4)',
    searchCurrent: 'rgba(255, 140, 0, 0.7)',
  },
  sepia: {
    bg: '#f4ecd8',
    fg: '#433422',
    muted: '#7a6a53',
    accent: '#a0522d',
    border: '#d8c9a7',
    codeBg: '#ebe0c6',
    codeFg: 'var(--rm-fg)',
    link: '#8b4513',
    navBg: '#ede3cb',
    search: 'rgba(255, 200, 0, 0.45)',
    searchCurrent: 'rgba(230, 120, 0, 0.7)',
  },
  'high-contrast': {
    bg: '#000000',
    fg: '#ffffff',
    muted: '#d0d0d0',
    accent: '#ffd600',
    border: '#ffffff',
    codeBg: '#111111',
    codeFg: 'var(--rm-fg)',
    link: '#6fc3ff',
    navBg: '#000000',
    search: 'rgba(255, 214, 0, 0.45)',
    searchCurrent: 'rgba(255, 120, 0, 0.9)',
  },
};

export const DEFAULT_HEADING_SIZES = [2, 1.5, 1.25, 1.1, 1, 0.9];

const SYSTEM_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'";

export function schemeForPreset(preset: ThemePreset): 'auto' | 'light' | 'dark' {
  switch (preset) {
    case 'light':
    case 'sepia':
      return 'light';
    case 'dark':
    case 'high-contrast':
      return 'dark';
    default:
      return 'auto';
  }
}

/** Strips characters that could break out of a CSS declaration. */
export function cssValue(value: string | undefined): string {
  return (value ?? '').replace(/[;{}<>\\]/g, '').trim();
}

function num(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function buildCssVariables(s: StyleSettings): string {
  const p = PRESETS[s.preset] ?? PRESETS.vscode;
  const scale = num(s.headingScale, 1, 0.5, 3);
  const vars: Record<string, string> = {
    '--rm-bg': cssValue(s.bodyBackgroundColor) || p.bg,
    '--rm-fg': cssValue(s.bodyTextColor) || p.fg,
    '--rm-muted': p.muted,
    '--rm-accent': p.accent,
    '--rm-border': p.border,
    '--rm-code-bg': p.codeBg,
    '--rm-code-fg': p.codeFg,
    '--rm-link': p.link,
    '--rm-nav-bg': p.navBg,
    '--rm-font': cssValue(s.bodyFontFamily) || SYSTEM_FONT,
    '--rm-font-size': `${num(s.bodyFontSize, 15, 8, 40)}px`,
    '--rm-line-height': String(num(s.bodyLineHeight, 1.65, 1, 3)),
    '--rm-max-width': s.bodyMaxWidth > 0 ? `${Math.round(s.bodyMaxWidth)}px` : 'none',
    '--rm-heading-font': cssValue(s.headingFontFamily) || 'var(--rm-font)',
    '--rm-heading-hl': cssValue(s.headingHighlightColor) || p.accent,
    '--rm-search-bg': cssValue(s.searchHighlightColor) || p.search,
    '--rm-search-current-bg': cssValue(s.searchCurrentHighlightColor) || p.searchCurrent,
    '--rm-nav-width': `${num(s.navWidth, 260, 120, 600)}px`,
  };
  // Only set when customized: preview.css falls back to an accent tint / body text color.
  const thBg = cssValue(s.tableHeaderBackgroundColor);
  const thFg = cssValue(s.tableHeaderTextColor);
  if (thBg) vars['--rm-table-header-bg'] = thBg;
  if (thFg) vars['--rm-table-header-fg'] = thFg;
  DEFAULT_HEADING_SIZES.forEach((size, i) => {
    const key = `h${i + 1}` as keyof HeadingMap;
    vars[`--rm-${key}-size`] = cssValue(s.headingFontSizes?.[key]) || `${+(size * scale).toFixed(3)}em`;
    vars[`--rm-${key}-color`] = cssValue(s.headingColors?.[key]) || 'inherit';
  });
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `:root {\n${body}\n}\n`;
}
