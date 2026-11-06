import type { ToWebview, UiConfig } from '../src/protocol';
import { $, getState, patchState, post } from './api';
import { decorateCodeBlocks, initCodeBlocks } from './codeblocks';
import { renderMermaid, rerenderMermaid } from './mermaid';
import { initNav, setHeadings, updateActive } from './nav';
import { initNavResize, syncNavWidth } from './navResize';
import { sanitize } from './sanitize';
import { initScrollMap, invalidate, isSuppressed, lineAtTop, scrollProgrammatically, scrollToLine, updateAnchor } from './scroll';
import { initSearch, reapplySearch, setSearch } from './search';
import { buildSections, collapsedSlugs, expandTo, setAllCollapsed, setCollapsed } from './sections';
import { initSettingsPanel, updateSettingsPanel } from './settingsPanel';

const content = $('rm-content');
const body = document.body;
let ui: UiConfig | undefined;
let lastRender: Extract<ToWebview, { type: 'render' }> | undefined;
let rendered = false;
let scheme: 'light' | 'dark' = 'light';

// ---- color scheme ------------------------------------------------------------------------

function resolveScheme(): 'light' | 'dark' {
  if (ui && ui.scheme !== 'auto') return ui.scheme;
  const c = body.classList;
  if (c.contains('vscode-high-contrast-light')) return 'light';
  return c.contains('vscode-dark') || c.contains('vscode-high-contrast') ? 'dark' : 'light';
}

function updateScheme(): void {
  const next = resolveScheme();
  body.dataset.scheme = next;
  if (next !== scheme) {
    scheme = next;
    if (rendered && ui?.mermaid) void rerenderMermaid(content, scheme).then(invalidate);
  }
}

// VS Code toggles body classes when the color theme changes.
new MutationObserver(updateScheme).observe(body, { attributes: true, attributeFilter: ['class'] });

// ---- config ------------------------------------------------------------------------------

function applyConfig(msg: Extract<ToWebview, { type: 'config' }>): void {
  const prev = ui;
  ui = msg.ui;
  $('rm-vars').textContent = msg.css;
  $('rm-custom').textContent = msg.customCss;
  body.classList.toggle('rm-nav-visible', ui.navShow);
  body.dataset.navPosition = ui.navPosition;
  body.dataset.headingHighlight = ui.headingHighlight;
  body.dataset.preset = ui.preset;
  updateScheme();
  updateSettingsPanel(ui);
  syncNavWidth();
  invalidate();

  const needsRerender =
    prev &&
    (prev.navMaxDepth !== ui.navMaxDepth || prev.collapsible !== ui.collapsible || prev.copyButton !== ui.copyButton);
  if (needsRerender && lastRender) renderContent(lastRender);
}

// ---- render ------------------------------------------------------------------------------

function renderContent(msg: Extract<ToWebview, { type: 'render' }>): void {
  if (!ui) return;
  lastRender = msg;
  const scrollY = window.scrollY;
  const state = getState();
  const previous = rendered ? new Set(collapsedSlugs(content)) : state.collapsed ? new Set(state.collapsed) : undefined;

  content.replaceChildren(sanitize(msg.html));
  buildSections(content, {
    collapsible: ui.collapsible,
    startCollapsedBelowLevel: ui.startCollapsedBelowLevel,
    collapsed: previous,
  });
  decorateCodeBlocks(content, ui.copyButton);
  setHeadings(msg.headings, ui.navMaxDepth);
  invalidate();

  if (rendered) {
    scrollProgrammatically(scrollY);
  } else if (state.scrollLine !== undefined) {
    scrollToLine(state.scrollLine);
  }
  rendered = true;
  saveCollapsed();
  reapplySearch(content);
  if (msg.hasMermaid && ui.mermaid) void renderMermaid(content, scheme).then(invalidate);
}

function saveCollapsed(): void {
  patchState({ collapsed: collapsedSlugs(content) });
}

function revealHeading(slug: string): void {
  const el = document.getElementById(slug);
  if (!el || !content.contains(el)) return;
  if (expandTo(el)) {
    invalidate();
    saveCollapsed();
  }
  // User-initiated navigation: let the scroll propagate to the source editor.
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 8, behavior: 'instant' });
  body.classList.remove('rm-nav-drawer');
}

// ---- events ------------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'config':
      applyConfig(msg);
      break;
    case 'render':
      renderContent(msg);
      break;
    case 'highlight':
      setSearch(content, msg);
      break;
    case 'scrollToLine':
      scrollToLine(msg.line);
      updateActive();
      break;
    case 'revealHeading':
      revealHeading(msg.slug);
      break;
  }
});

let scrollFrame = 0;
let lastSentLine = -1;
window.addEventListener(
  'scroll',
  () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateActive();
      updateAnchor();
      const line = lineAtTop();
      patchState({ scrollLine: line });
      if (!isSuppressed() && ui?.scrollSync && Math.abs(line - lastSentLine) >= 0.5) {
        lastSentLine = line;
        post({ type: 'revealLine', line });
      }
    });
  },
  { passive: true },
);

content.addEventListener('click', (e) => {
  const target = e.target as Element;
  const fold = target.closest('.rm-fold');
  if (fold) {
    e.preventDefault();
    const section = fold.closest('section.rm-section');
    if (section) {
      setCollapsed(section, !section.classList.contains('rm-collapsed'));
      invalidate();
      saveCollapsed();
      updateActive();
    }
    return;
  }
  const a = target.closest('a');
  if (!a) return;
  const href = a.dataset.href ?? a.getAttribute('href') ?? '';
  if (!href) return;
  e.preventDefault();
  if (href.startsWith('#')) {
    let slug = href.slice(1);
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* keep raw */
    }
    revealHeading(slug);
  } else {
    post({ type: 'openLink', href });
  }
});

// Double-click a heading (outside text selection) to jump to it in the source.
content.addEventListener('dblclick', (e) => {
  const heading = (e.target as Element).closest<HTMLElement>('.rm-heading, h1, h2, h3, h4, h5, h6');
  if (heading?.dataset.line) {
    window.getSelection()?.removeAllRanges();
    post({ type: 'showSource', line: Number(heading.dataset.line) });
  }
});

// One button: "Collapse all" while any section is expanded, "Expand all" once every section is collapsed.
const foldAll = $('rm-fold-all');

function updateFoldAll(): void {
  const sections = content.querySelectorAll('section.rm-section');
  foldAll.hidden = sections.length === 0;
  const anyExpanded = [...sections].some((s) => !s.classList.contains('rm-collapsed'));
  const label = anyExpanded ? 'Collapse all sections' : 'Expand all sections';
  foldAll.dataset.mode = anyExpanded ? 'collapse' : 'expand';
  foldAll.title = label;
  foldAll.setAttribute('aria-label', label);
}

// Sections change on render, fold clicks, search reveal and outline navigation.
new MutationObserver(updateFoldAll).observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

foldAll.addEventListener('click', () => {
  setAllCollapsed(content, foldAll.dataset.mode === 'collapse');
  invalidate();
  saveCollapsed();
  updateActive();
});
$('rm-toggle-nav').addEventListener('click', () => {
  if (window.innerWidth < 640) body.classList.toggle('rm-nav-drawer');
  else post({ type: 'updateSetting', key: 'nav.show', value: !ui?.navShow });
});
$('rm-top').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'instant' }));

initScrollMap(content);
initSearch($('rm-search-badge'));
initCodeBlocks(content);
initSettingsPanel($('rm-settings'), $('rm-open-settings'));
initNav({
  list: $('rm-nav-list') as HTMLOListElement,
  empty: $('rm-nav-empty'),
  filter: $('rm-nav-filter') as HTMLInputElement,
  content,
  onNavigate: revealHeading,
});
initNavResize($('rm-nav'), $('rm-nav-resizer'));
patchState({});
post({ type: 'ready' });
