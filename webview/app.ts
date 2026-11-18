// The webview's wiring: config and render messages, the render pipeline (`renderContent`), the message
// router, toolbar buttons and link clicks. `main.ts` (the bundle entry) only calls `startPreview()`; the
// work happens there and not at import time, so tests can build the shell first and start the preview
// against it. The render steps are passed in (`RenderStages`) so a test can record their order.
import type { ChangesMode, ChangesView, ToWebview, UiConfig } from '../src/protocol';
import { assertNever } from '../src/assertNever';
import { $, getState, patchState, post } from './api';
import { acceptRender, baselineFor, shouldRequestBaseline } from './baseline';
import { initChangeGutter, scheduleChangeGutter } from './changeGutter';
import { applyChanges } from './changes';
import { hideBlockActions, initBlockActions, registerBlockAction, setBlockActionsEnabled } from './blockActions';
import { type CodeBlockOptions, decorateCodeBlocks, initCodeBlocks } from './codeblocks';
import { createDebouncedSaver } from './debouncedSaver';
import { deferRender, editBlockAtLine, initBlockEdit, isEditing, onBlockSource, onEditResult, onTaskResult, setEditable, syncTaskCheckboxes } from './editBlock';
import { type MermaidOptions, renderMermaid } from './mermaid';
import { decorateDiagrams, initDiagramZoom } from './mermaidZoom';
import { cancelListDrag, initListDrag, onMoveResult, setListDragEnabled } from './listDrag';
import { flashLineTarget, lineTarget } from './goToLine';
import { initNav, setHeadings, setTaskBadges, updateActive } from './nav';
import { initNavResize, syncNavWidth } from './navResize';
import { type RawBlocks, patchBlocks, rawBlocks } from './patch';
import { type Split, splitPoint } from './progressive';
import { sanitize } from './sanitize';
import { initScrollMap, invalidate, isSuppressed, lineAtTop, scrollProgrammatically, scrollToLine, updateAnchor } from './scroll';
import { initSearch, reapplySearch, setSearch } from './search';
import { buildSections, collapsedSlugs, expandTo, extendSections, onSectionsChange, revealFound, setAllCollapsed, setCollapsed } from './sections';
import { initSettingsPanel, updateSettingsPanel } from './settingsPanel';
import { initSourceLines, setSourceLines } from './sourceLines';
import { applyTableWidths, cancelTableResize, initTableResize } from './tableResize';
import { initTaskProgress, updateTaskProgress } from './taskProgress';

const SCROLL_SAVE_MS = 200;

const codeBlockOptions = (ui: UiConfig): CodeBlockOptions => ({ copyButton: ui.copyButton, lineNumbers: ui.codeLineNumbers });

/**
 * Tags each top-level block so the preview's context menu (Edit Block, Show Source) knows its line.
 * `rmHtml` hides Edit Block for raw HTML blocks. It is always set (also `false`): VS Code merges the
 * context of the clicked element's ancestors, and a Markdown block can sit inside an unclosed raw `<div>`.
 */
export function stampMenuContext(content: HTMLElement): void {
  for (const block of content.querySelectorAll<HTMLElement>('[data-line-end]')) {
    block.dataset.vscodeContext = JSON.stringify({
      webviewSection: 'rm-block',
      rmLine: Number(block.dataset.line),
      rmHtml: block.hasAttribute('data-rm-html'),
    });
  }
}

/** The steps `renderContent` runs, in its order. Production always uses `RENDER_STAGES`. */
export interface RenderStages {
  sanitize: typeof sanitize;
  baselineFor: typeof baselineFor;
  applyChanges: typeof applyChanges;
  buildSections: typeof buildSections;
  decorateCodeBlocks: typeof decorateCodeBlocks;
  applyTableWidths: typeof applyTableWidths;
  stampMenuContext: typeof stampMenuContext;
  syncTaskCheckboxes: typeof syncTaskCheckboxes;
  setHeadings: typeof setHeadings;
  updateTaskProgress: typeof updateTaskProgress;
  reapplySearch: typeof reapplySearch;
  scheduleChangeGutter: typeof scheduleChangeGutter;
  renderMermaid: typeof renderMermaid;
}

export const RENDER_STAGES: RenderStages = {
  sanitize,
  baselineFor,
  applyChanges,
  buildSections,
  decorateCodeBlocks,
  applyTableWidths,
  stampMenuContext,
  syncTaskCheckboxes,
  setHeadings,
  updateTaskProgress,
  reapplySearch,
  scheduleChangeGutter,
  renderMermaid,
};

/**
 * Starts the preview on the shell from `src/preview/html.ts` (throws on a missing `#rm-…` element) and
 * posts `ready`. Call once per page: the listeners and the other modules' `init*` calls are not undone.
 */
export function startPreview(stages: RenderStages = RENDER_STAGES): void {
  const content = $('rm-content');
  const body = document.body;
  let ui: UiConfig | undefined;
  let lastRender: Extract<ToWebview, { type: 'render' }> | undefined;
  let rendered = false;
  /**
   * The blocks `#rm-content` shows, when the next render may patch them in place (`patch.ts`):
   * undefined after a render with change marks, or while something else may have reshaped the DOM.
   */
  let shownBlocks: RawBlocks | undefined;
  /** The rest of a render shown in two parts (`progressive.ts`), until `completeRest` adds it. */
  let pendingRest:
    | {
        msg: Extract<ToWebview, { type: 'render' }>;
        blocks: RawBlocks;
        split: Split;
        /** Collapsed slugs the whole render started from (for the sections still to come). */
        collapsed: ReadonlySet<string> | undefined;
        frame?: number;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let scheme: 'light' | 'dark' = 'light';

  // ---- color scheme ----------------------------------------------------------------------

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
      syncMermaid();
    }
  }

  // VS Code toggles body classes when the color theme changes.
  new MutationObserver(updateScheme).observe(body, { attributes: true, attributeFilter: ['class'] });

  // ---- mermaid ---------------------------------------------------------------------------

  function mermaidOptions(config: UiConfig): MermaidOptions {
    return {
      scheme,
      theme: config.mermaidTheme,
      look: config.mermaidLook,
    };
  }

  /** Redraws diagrams whose theme, look or (for the `auto` theme) preview colors changed. */
  function syncMermaid(): void {
    if (rendered && ui?.mermaid) void stages.renderMermaid(content, mermaidOptions(ui)).then(afterMermaid);
  }

  function afterMermaid(): void {
    decorateDiagrams(content);
    invalidate();
  }

  // VS Code sets its theme colors on <html style>; the `auto` diagram theme is colored from them.
  // Debounced: dragging the outline width also writes there on every pointer move.
  let themeColorTimer: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    clearTimeout(themeColorTimer);
    themeColorTimer = setTimeout(syncMermaid, 150);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // ---- config ----------------------------------------------------------------------------

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
    setEditable(ui.editable, ui.editDoubleClick);
    setBlockActionsEnabled(ui.editable);
    setListDragEnabled(ui.editable);
    setSourceLines(ui.sourceLineNumbers);
    // Context keys for the `webview/context` menu (merged with the block's own, see stampMenuContext).
    body.dataset.vscodeContext = JSON.stringify({ rmEditable: ui.editable });
    syncNavWidth();
    invalidate();
    // A new setting value wins over this preview's toolbar toggle (the extension re-renders).
    if (prev && prev.changesMode !== ui.changesMode) patchState({ changesMode: undefined });

    const needsRerender =
      prev &&
      (prev.navMaxDepth !== ui.navMaxDepth ||
        prev.collapsible !== ui.collapsible ||
        prev.copyButton !== ui.copyButton ||
        prev.codeLineNumbers !== ui.codeLineNumbers ||
        prev.taskProgress !== ui.taskProgress ||
        prev.agentProgress !== ui.agentProgress);
    if (needsRerender && lastRender) {
      // These settings change what every block looks like: render all of it again.
      shownBlocks = undefined;
      renderContent(lastRender);
    }
    // New diagram settings, or new preview colors for the `auto` diagram theme.
    else syncMermaid();
  }

  // ---- render ----------------------------------------------------------------------------

  function renderContent(msg: Extract<ToWebview, { type: 'render' }>): void {
    if (!ui) return;
    // Held back while a block is being edited in place; applied when the editor closes.
    if (deferRender(msg)) {
      // The open editor stands in for a block; when it closes it applies this render over it.
      shownBlocks = undefined;
      return;
    }
    hideBlockActions();
    cancelListDrag();
    cancelTableResize();
    // Read before the pending rest is dropped: its sections are not in the DOM yet.
    const carried = rendered ? collapsedNow() : undefined;
    cancelRest();
    lastRender = msg;
    const scrollY = window.scrollY;
    // The restore below reads scrollLine from the saved state, which must not lag behind the scroll.
    scrollLineSaver.flush();
    const state = getState();
    const mode = changesMode();
    // Change marks clone and wrap blocks all over the document: those renders are always full.
    const marks = msg.changes !== undefined && mode !== 'off';
    const next = marks ? undefined : rawBlocks(msg.html);
    const prevBlocks = shownBlocks;
    shownBlocks = next;
    const codeOpts = codeBlockOptions(ui);
    if (
      rendered &&
      prevBlocks &&
      next &&
      patchBlocks(content, prevBlocks, next, {
        sanitize: stages.sanitize,
        decorate: (box) => stages.decorateCodeBlocks(box, codeOpts),
      })
    ) {
      body.dataset.changes = '';
      updateChangesButton(undefined);
      finishRender(msg, state, scrollY);
      return;
    }

    const previous = rendered ? carried : state.collapsed ? new Set(state.collapsed) : undefined;
    // A long document without change marks: the part up to the view first, the rest after the first frame.
    const split = next && splitPoint(next, rendered ? lineAtTop() : (state.scrollLine ?? 0));
    if (next && split) shownBlocks = undefined;
    content.replaceChildren(stages.sanitize(next && split ? next.html.slice(0, split.at).join('') : msg.html));
    const baseline = msg.changes && mode !== 'off' ? stages.baselineFor(msg.changes.baselineId) : undefined;
    // Never marks against a baseline other than the one the ops were computed from. A missing one is asked for
    // (once); until the extension re-sends this render with it, the current content shows without change marks.
    if (msg.changes && mode !== 'off' && !baseline && shouldRequestBaseline(msg.changes.baselineId)) {
      post({ type: 'needBaseline', id: msg.changes.baselineId });
    }
    const shown = msg.changes && baseline && mode !== 'off' ? mode : undefined;
    if (msg.changes && baseline && shown) stages.applyChanges(content, msg.changes.ops, baseline, shown);
    body.dataset.changes = shown ?? '';
    updateChangesButton(shown);
    stages.buildSections(content, {
      collapsible: ui.collapsible,
      startCollapsedBelowLevel: ui.startCollapsedBelowLevel,
      collapsed: previous,
    });
    stages.decorateCodeBlocks(content, codeBlockOptions(ui));
    if (!next || !split) {
      finishRender(msg, state, scrollY);
      return;
    }
    finishRender(msg, state, scrollY, true);
    pendingRest = { msg, blocks: next, split, collapsed: previous };
    // Not enough to fill the view at the restored position (very long lines?): add the rest now.
    if (content.getBoundingClientRect().bottom < window.innerHeight) {
      completeRest();
      return;
    }
    const rest = pendingRest;
    // After the first frame is painted: rAF runs before it, the timeout after it.
    rest.frame = requestAnimationFrame(() => {
      rest.frame = undefined;
      rest.timer = setTimeout(completeRest, 0);
    });
  }

  /** Adds the rest of a render shown in two parts, as if the whole render had been done at once. */
  function completeRest(): void {
    const rest = pendingRest;
    if (!rest || !ui) return;
    cancelRest();
    const box = document.createElement('div');
    box.append(stages.sanitize(rest.blocks.html.slice(rest.split.at).join('')));
    stages.decorateCodeBlocks(box, codeBlockOptions(ui));
    extendSections(content, [...box.childNodes], {
      collapsible: ui.collapsible,
      startCollapsedBelowLevel: ui.startCollapsedBelowLevel,
      collapsed: rest.collapsed,
    });
    stages.applyTableWidths();
    stages.stampMenuContext(content);
    stages.syncTaskCheckboxes();
    invalidate();
    finishWholeRender(rest.msg);
    shownBlocks = rest.blocks;
  }

  function cancelRest(): void {
    if (!pendingRest) return;
    if (pendingRest.frame !== undefined) cancelAnimationFrame(pendingRest.frame);
    clearTimeout(pendingRest.timer);
    pendingRest = undefined;
  }

  /** Adds the rest first if a message needs content past the first part (a line at or after `line`). */
  function needLine(line: number): void {
    if (pendingRest && line >= pendingRest.split.restLine) completeRest();
  }

  /** Collapsed section slugs, including those of the pending rest (not in the DOM yet). */
  function collapsedNow(): Set<string> {
    const slugs = new Set(collapsedSlugs(content));
    if (pendingRest?.collapsed) {
      const shown = new Set([...content.querySelectorAll<HTMLElement>('section.rm-section')].map((s) => s.dataset.slug));
      for (const s of pendingRest.collapsed) if (!shown.has(s)) slugs.add(s);
    }
    return slugs;
  }

  /**
   * The render steps after the blocks are in place, shared by the full and the patched render.
   * `firstPart`: only the first part of a two-part render is in place; the steps that need the
   * whole document (task progress, saved collapsed state, search, change bars, diagrams) wait for
   * `completeRest`.
   */
  function finishRender(msg: Extract<ToWebview, { type: 'render' }>, state: ReturnType<typeof getState>, scrollY: number, firstPart = false): void {
    if (!ui) return;
    stages.applyTableWidths();
    stages.stampMenuContext(content);
    stages.syncTaskCheckboxes();
    stages.setHeadings(msg.headings, ui.navMaxDepth);
    invalidate();

    if (rendered) {
      scrollProgrammatically(scrollY);
    } else if (state.scrollLine !== undefined) {
      scrollToLine(state.scrollLine);
    }
    rendered = true;
    if (!firstPart) finishWholeRender(msg);
  }

  function finishWholeRender(msg: Extract<ToWebview, { type: 'render' }>): void {
    if (!ui) return;
    // After the scroll restore: following a newly started step may scroll and expand its section.
    setTaskBadges(stages.updateTaskProgress({ enabled: ui.agentProgress, progress: ui.taskProgress, busy: isEditing() }));
    saveCollapsed();
    stages.reapplySearch(content);
    stages.scheduleChangeGutter();
    // Removed blocks may bring diagrams the current version no longer has.
    if (ui.mermaid && (msg.hasMermaid || content.querySelector('.rm-mermaid'))) void stages.renderMermaid(content, mermaidOptions(ui)).then(afterMermaid);
  }

  // ---- changes vs git index --------------------------------------------------------------

  /** The setting, unless this preview's toolbar toggle overrides it. */
  function changesMode(): ChangesMode {
    if (!ui || ui.changesMode === 'off') return 'off';
    return getState().changesMode ?? ui.changesMode;
  }

  const changesButton = $('rm-toggle-changes');

  function updateChangesButton(mode: ChangesView | undefined): void {
    changesButton.hidden = !mode;
    const label = mode === 'inline' ? 'Show changes as bars only' : 'Show changes inline';
    changesButton.title = label;
    changesButton.setAttribute('aria-label', label);
    changesButton.setAttribute('aria-pressed', String(mode === 'inline'));
  }

  function toggleChanges(): void {
    const mode = changesMode();
    if (mode === 'off') return;
    patchState({ changesMode: mode === 'inline' ? 'gutter' : 'inline' });
    if (lastRender) renderContent(lastRender);
  }

  function saveCollapsed(): void {
    patchState({ collapsed: [...collapsedNow()] });
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

  function goToLine(line: number): void {
    const target = lineTarget(content, line);
    if (target && expandTo(target)) {
      invalidate();
      saveCollapsed();
    }
    scrollToLine(line);
    updateActive();
    if (target) flashLineTarget(target);
  }

  // ---- events ----------------------------------------------------------------------------

  window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
    const msg = event.data;
    // A message that needs the whole document adds the pending rest of a two-part render first.
    if (msg.type === 'highlight') needLine(msg.blockLine);
    else if (msg.type === 'scrollToLine' || msg.type === 'goToLine') needLine(msg.line);
    else if (msg.type !== 'render') completeRest();
    switch (msg.type) {
      case 'config':
        applyConfig(msg);
        break;
      case 'render':
        // The baseline is stored on arrival: renderContent may hold this message back for an open editor and
        // replace it with a later one that cites the same baseline without the HTML.
        renderContent(acceptRender(msg));
        break;
      case 'highlight':
        setSearch(content, msg);
        break;
      case 'scrollToLine':
        scrollToLine(msg.line);
        updateActive();
        break;
      case 'goToLine':
        goToLine(msg.line);
        break;
      case 'revealHeading':
        revealHeading(msg.slug);
        break;
      case 'blockSource':
        onBlockSource(msg);
        break;
      case 'editResult':
        onEditResult(msg);
        break;
      case 'taskResult':
        onTaskResult(msg);
        break;
      case 'startEdit':
        editBlockAtLine(msg.line);
        break;
      case 'moveResult':
        onMoveResult(msg);
        break;
      case 'toggleChanges':
        toggleChanges();
        break;
      default:
        assertNever(msg);
    }
  });

  // The scroll line only has to survive a reload, so it is written once scrolling pauses instead of
  // on every frame (patchState copies and serializes the whole state). Patching just this field at
  // write time keeps it from overwriting newer values of the other fields.
  const scrollLineSaver = createDebouncedSaver((scrollLine: number) => patchState({ scrollLine }), SCROLL_SAVE_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') scrollLineSaver.flush();
  });
  window.addEventListener('pagehide', () => scrollLineSaver.flush());

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
        scrollLineSaver.save(line);
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

  // The find widget found text inside a collapsed section: expand it, as a fold click would.
  content.addEventListener('beforematch', (e) => {
    if (!revealFound(e.target)) return;
    invalidate();
    saveCollapsed();
    updateActive();
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

  // Sections change on render, fold clicks, fold all, search reveal and outline navigation; all of
  // them go through sections.ts, which reports each change here.
  onSectionsChange(updateFoldAll);

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
  changesButton.addEventListener('click', toggleChanges);

  initScrollMap(content);
  initChangeGutter(content, $('rm-main'));
  initSourceLines(content, $('rm-main'));
  initSearch($('rm-search-badge'));
  initCodeBlocks(content);
  initDiagramZoom(content);
  initBlockActions(content);
  registerBlockAction({
    id: 'source',
    label: 'Show source',
    placement: 'menu',
    run: (block) => post({ type: 'showSource', line: Number(block.dataset.line) }),
  });
  initBlockEdit({ content, docVersion: () => lastRender?.docVersion, render: renderContent });
  initListDrag({ content, docVersion: () => lastRender?.docVersion, isBusy: isEditing });
  initTableResize(content);
  initSettingsPanel($('rm-settings'), $('rm-open-settings'));
  initTaskProgress({ content, bar: $('rm-task-progress'), followButton: $('rm-follow-tasks') as HTMLButtonElement });
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
}
