// Lazily loads Mermaid only when the document contains diagrams, and caches rendered SVGs so
// live re-renders while typing do not re-layout unchanged diagrams.
import type { MermaidLook, MermaidTheme } from '../src/protocol';
import { toHex } from './color';

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  run(options: { nodes: ArrayLike<HTMLElement>; suppressErrors?: boolean }): Promise<void>;
}

declare global {
  interface Window {
    mermaid?: MermaidApi;
  }
}

export interface MermaidOptions {
  scheme: 'light' | 'dark';
  /** `auto` = `base` colored from the preview's `--rm-*` colors; paired themes follow `scheme`. */
  theme: MermaidTheme;
  look: MermaidLook;
}

let loading: Promise<MermaidApi> | undefined;
/** Key of the config Mermaid was last initialized with. */
let initializedKey = '';
const svgCache = new Map<string, string>();

function load(): Promise<MermaidApi> {
  loading ??= new Promise<MermaidApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = document.body.dataset.mermaidSrc ?? '';
    script.nonce = document.body.dataset.nonce ?? '';
    script.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid failed to load')));
    script.onerror = () => reject(new Error('Mermaid failed to load'));
    document.head.append(script);
  });
  return loading;
}

// A hidden element for resolving `--rm-*` expressions (var(), color-mix()) to computed values.
let probeEl: HTMLElement | undefined;
function computed(prop: 'color' | 'fontFamily', value: string): string {
  if (!probeEl) {
    probeEl = document.createElement('span');
    probeEl.hidden = true;
    document.body.append(probeEl);
  }
  probeEl.style[prop] = value;
  return getComputedStyle(probeEl)[prop];
}

/**
 * Theme variables for Mermaid's `base` theme taken from the preview's colors. Mermaid derives the
 * rest (and needs plain colors for that, hence #rrggbb rather than var()).
 */
function previewThemeVariables(dark: boolean): Record<string, unknown> {
  const bg = computed('color', 'var(--rm-bg)');
  const color = (css: string) => toHex(computed('color', css), bg);
  const background = color('var(--rm-bg)');
  const text = color('var(--rm-fg)');
  const accent = color('var(--rm-accent)');
  const border = color('var(--rm-border)');
  const muted = color('var(--rm-muted)');
  const node = color('color-mix(in srgb, var(--rm-accent) 14%, var(--rm-bg))');
  const secondary = color('color-mix(in srgb, var(--rm-accent) 7%, var(--rm-bg))');
  const subtle = color('color-mix(in srgb, var(--rm-fg) 5%, var(--rm-bg))');
  return {
    darkMode: dark,
    useGradient: false,
    // Used by the `neo` look; `base` has a light grey one that glows on dark backgrounds.
    dropShadow: dark ? 'drop-shadow(1px 2px 2px rgba(0, 0, 0, 0.6))' : 'drop-shadow(1px 2px 2px rgba(0, 0, 0, 0.15))',
    background,
    fontFamily: computed('fontFamily', 'var(--rm-font)'),
    primaryColor: node,
    primaryTextColor: text,
    primaryBorderColor: accent,
    secondaryColor: secondary,
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: subtle,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    lineColor: muted,
    textColor: text,
    titleColor: text,
    edgeLabelBackground: background,
    clusterBkg: subtle,
    clusterBorder: border,
    noteBkgColor: secondary,
    noteTextColor: text,
    noteBorderColor: border,
  };
}

/** Mermaid's dark variant of a theme; themes without one are used as is. */
const DARK_VARIANT: Partial<Record<MermaidTheme, string>> = {
  default: 'dark',
  neo: 'neo-dark',
  redux: 'redux-dark',
  'redux-color': 'redux-dark-color',
};

function mermaidConfig(opts: MermaidOptions): Record<string, unknown> {
  const base = { startOnLoad: false, securityLevel: 'strict', look: opts.look };
  if (opts.theme !== 'auto') {
    const theme = (opts.scheme === 'dark' && DARK_VARIANT[opts.theme]) || opts.theme;
    return { ...base, theme };
  }
  return { ...base, theme: 'base', themeVariables: previewThemeVariables(opts.scheme === 'dark') };
}

let queue: Promise<void> = Promise.resolve();

/**
 * Renders `pre.mermaid` blocks not yet rendered with these options; diagrams rendered with other
 * options (or other preview colors, for the `auto` theme) are redrawn. Cheap when nothing changed.
 * Calls run one after another so a re-initialize never lands in the middle of a `mermaid.run`.
 */
export function renderMermaid(root: HTMLElement, opts: MermaidOptions): Promise<void> {
  queue = queue.then(() => render(root, opts)).catch((err: unknown) => console.error(err));
  return queue;
}

async function render(root: HTMLElement, opts: MermaidOptions): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre.mermaid')];
  if (blocks.length === 0) return;
  const config = mermaidConfig(opts);
  const key = JSON.stringify(config);
  const pending: HTMLElement[] = [];
  for (const block of blocks) {
    block.dataset.src ??= block.textContent ?? '';
    if (block.hasAttribute('data-processed')) {
      if (block.dataset.rmConfig === key) continue;
      block.removeAttribute('data-processed');
      block.textContent = block.dataset.src;
    }
    const cached = svgCache.get(`${key}\n${block.dataset.src}`);
    if (cached) {
      block.innerHTML = cached;
      block.setAttribute('data-processed', 'true');
      block.dataset.rmConfig = key;
    } else {
      pending.push(block);
    }
  }
  if (pending.length === 0) return;

  let mermaid: MermaidApi;
  try {
    mermaid = await load();
  } catch (err) {
    pending.forEach((b) => b.classList.add('rm-mermaid-error'));
    console.error(err);
    return;
  }
  // `initialize` starts from Mermaid's defaults each time, so nothing leaks between themes.
  if (initializedKey !== key) {
    mermaid.initialize(config);
    initializedKey = key;
  }
  await mermaid.run({ nodes: pending, suppressErrors: true });
  for (const block of pending) {
    block.dataset.rmConfig = key;
    if (block.querySelector('svg') && block.dataset.src !== undefined) {
      if (svgCache.size > 200) svgCache.clear();
      svgCache.set(`${key}\n${block.dataset.src}`, block.innerHTML);
    }
  }
}
