// Zoom and pan for rendered Mermaid diagrams, inline and in a full-screen view.
//
// Inline: a hover toolbar (− level + reset ⛶), Ctrl/Cmd+wheel or trackpad pinch zooms around the
// pointer, dragging pans while zoomed, keys when the diagram has focus. The SVG is transformed inside
// its `pre`, which clips it while zoomed, so the page layout never changes. Views survive live
// re-renders (keyed by diagram source + occurrence).
//
// Full screen: an overlay over the whole preview (webviews may not use the Fullscreen API) showing a
// copy of the SVG fitted to the window; any wheel zooms, dragging always pans, Escape closes. The copy
// is refreshed when the diagram re-renders (typing, theme change).
import { REMOVED_SELECTOR } from './changes';

interface View {
  scale: number;
  x: number;
  y: number;
}

/** An element whose direct child SVG is zoomed, with its view. */
interface Target {
  box: HTMLElement;
  view: View;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const STEP = 1.25;
const PAN_STEP = 40;
/** Largest factor a small diagram is enlarged by when fitted to the full-screen view. */
const MAX_FIT = 3;
const FIT_PADDING = 32;
const DIAGRAM = '.rm-mermaid > pre.mermaid';

const views = new Map<string, View>();
const viewOf = new WeakMap<HTMLElement, View>();
const levelOf = new WeakMap<HTMLElement, HTMLElement>();
/** Diagram keys by position at the last decorate, so a diagram being edited keeps its view. */
let lastKeys: string[] = [];

const isIdentity = (v: View) => v.scale === 1 && v.x === 0 && v.y === 0;
const svgOf = (box: HTMLElement) => box.querySelector<SVGSVGElement>(':scope > svg');

function apply({ box, view }: Target): void {
  const svg = svgOf(box);
  if (!svg) return;
  const zoomed = !isIdentity(view);
  svg.style.transformOrigin = '0 0';
  svg.style.transform = zoomed ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : '';
  box.classList.toggle('rm-zoomed', zoomed);
  const level = levelOf.get(box);
  if (level) level.textContent = `${Math.round(view.scale * 100)}%`;
}

function reset(t: Target): void {
  t.view.scale = 1;
  t.view.x = 0;
  t.view.y = 0;
  apply(t);
}

/** Zooms by `factor` keeping the point under (clientX, clientY) in place; default: the box center. */
function zoomAt(t: Target, factor: number, clientX?: number, clientY?: number): void {
  const { box, view } = t;
  const svg = svgOf(box);
  if (!svg) return;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  if (scale === view.scale) return;
  // With origin 0 0 the transformed box's top-left is the untransformed one moved by (x, y).
  const rect = svg.getBoundingClientRect();
  const frame = box.getBoundingClientRect();
  const px = (clientX ?? frame.left + frame.width / 2) - (rect.left - view.x);
  const py = (clientY ?? frame.top + frame.height / 2) - (rect.top - view.y);
  view.x = px - ((px - view.x) * scale) / view.scale;
  view.y = py - ((py - view.y) * scale) / view.scale;
  view.scale = scale;
  // Back at 100% after zooming in and out: snap home so the diagram is laid out as usual again.
  if (Math.abs(scale - 1) < 1e-6 && Math.abs(view.x) < 1 && Math.abs(view.y) < 1) return reset(t);
  apply(t);
}

function wheelZoom(t: Target, e: WheelEvent): void {
  e.preventDefault();
  const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
  zoomAt(t, Math.exp(-delta * 0.002), e.clientX, e.clientY);
}

function startPan(t: Target, e: PointerEvent): void {
  const { box, view } = t;
  e.preventDefault();
  box.focus({ preventScroll: true });
  const startX = e.clientX;
  const startY = e.clientY;
  const fromX = view.x;
  const fromY = view.y;
  box.setPointerCapture(e.pointerId);
  box.classList.add('rm-panning');
  const move = (ev: PointerEvent) => {
    view.x = fromX + ev.clientX - startX;
    view.y = fromY + ev.clientY - startY;
    apply(t);
  };
  const end = () => {
    box.classList.remove('rm-panning');
    box.removeEventListener('pointermove', move);
    box.removeEventListener('pointerup', end);
    box.removeEventListener('pointercancel', end);
  };
  box.addEventListener('pointermove', move);
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

/** + - 0 and arrows (arrows only while zoomed unless `panAlways`). Returns whether the key was used. */
function zoomKey(t: Target, e: KeyboardEvent, panAlways: boolean): boolean {
  const pan = (dx: number, dy: number) => {
    if (!panAlways && isIdentity(t.view)) return false;
    t.view.x += dx;
    t.view.y += dy;
    apply(t);
    return true;
  };
  switch (e.key) {
    case '+':
    case '=':
      zoomAt(t, STEP);
      return true;
    case '-':
    case '_':
      zoomAt(t, 1 / STEP);
      return true;
    case '0':
      reset(t);
      return true;
    case 'ArrowLeft':
      return pan(PAN_STEP, 0);
    case 'ArrowRight':
      return pan(-PAN_STEP, 0);
    case 'ArrowUp':
      return pan(0, PAN_STEP);
    case 'ArrowDown':
      return pan(0, -PAN_STEP);
    default:
      return false;
  }
}

function zoomButton(t: Target, action: string | undefined): void {
  if (action === 'in') zoomAt(t, STEP);
  else if (action === 'out') zoomAt(t, 1 / STEP);
  else if (action === 'reset') reset(t);
}

/** − level + reset, then `extra` buttons. */
function makeToolbar(box: HTMLElement, resetTitle: string, extra: [string, string, string][]): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'rm-zoom';
  const button = ([action, text, title]: [string, string, string]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.zoom = action;
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  };
  const level = document.createElement('span');
  level.className = 'rm-zoom-level';
  levelOf.set(box, level);
  bar.append(
    button(['out', '−', 'Zoom out (−)']),
    level,
    button(['in', '+', 'Zoom in (+)']),
    button(['reset', '⟲', resetTitle]),
    ...extra.map(button),
  );
  return bar;
}

// ---- inline -----------------------------------------------------------------------------

function inlineTarget(el: EventTarget | null): Target | undefined {
  const box = (el as Element | null)?.closest?.<HTMLElement>(DIAGRAM);
  const view = box && viewOf.get(box);
  return box && view && svgOf(box) ? { box, view } : undefined;
}

/** Adds zoom controls to rendered diagrams and restores their views. Run after every Mermaid render. */
export function decorateDiagrams(root: HTMLElement): void {
  const blocks = [...root.querySelectorAll<HTMLElement>(DIAGRAM)].filter((b) => !b.closest(REMOVED_SELECTOR));
  const seen = new Map<string, number>();
  const keys = blocks.map((b) => {
    const src = b.dataset.src ?? '';
    const n = seen.get(src) ?? 0;
    seen.set(src, n + 1);
    return `${n}\n${src}`;
  });
  const present = new Set(keys);
  blocks.forEach((pre, i) => {
    const key = keys[i];
    let view = views.get(key);
    // A diagram whose source changed in place (typing in it) inherits the view of the one it replaced.
    const prev = lastKeys[i];
    if (!view && prev !== undefined && !present.has(prev)) view = views.get(prev);
    view ??= { scale: 1, x: 0, y: 0 };
    views.set(key, view);
    viewOf.set(pre, view);
    if (!svgOf(pre)) return;
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', 'Diagram. Plus and minus zoom, arrow keys pan, 0 resets, F opens full screen.');
    const host = pre.parentElement;
    if (host && !host.querySelector(':scope > .rm-zoom')) {
      host.append(makeToolbar(pre, 'Reset (0)', [['full', '⛶', 'Full screen (F)']]));
    }
    apply({ box: pre, view });
  });
  for (const key of views.keys()) if (!present.has(key)) views.delete(key);
  if (full) refreshFull(blocks, keys);
  lastKeys = keys;
}

export function initDiagramZoom(root: HTMLElement): void {
  root.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.rm-mermaid > .rm-zoom button');
    const t = inlineTarget(b?.parentElement?.parentElement?.querySelector(':scope > pre.mermaid') ?? null);
    if (!b || !t) return;
    e.preventDefault();
    if (b.dataset.zoom === 'full') openFull(t.box);
    else zoomButton(t, b.dataset.zoom);
  });

  // Ctrl/Cmd+wheel; a trackpad pinch arrives as a wheel event with ctrlKey. Plain wheel scrolls the page.
  root.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const t = inlineTarget(e.target);
      if (t) wheelZoom(t, e);
    },
    { passive: false },
  );

  // Drag to pan, only while zoomed: an unzoomed diagram keeps normal text selection and clicks.
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = inlineTarget(e.target);
    if (t && !isIdentity(t.view)) startPan(t, e);
  });

  root.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!(e.target as Element).matches?.(DIAGRAM)) return;
    const t = inlineTarget(e.target);
    if (!t) return;
    if (e.key === 'f' || e.key === 'F') openFull(t.box);
    else if (!zoomKey(t, e, false)) return;
    e.preventDefault();
  });
}

// ---- full screen ------------------------------------------------------------------------

interface FullView {
  overlay: HTMLElement;
  target: Target;
  /** The inline diagram shown, its key and position, to follow it across re-renders. */
  source: HTMLElement;
  key: string;
  index: number;
  resize: ResizeObserver;
}

let full: FullView | undefined;

/**
 * Copies the inline SVG. Mermaid prefixes every id (markers, gradients, the scoped <style>) with
 * the SVG's own id, so renaming that prefix keeps the copy's references pointing at its own defs.
 */
function copySvg(svg: SVGSVGElement): SVGSVGElement {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const id = svg.id;
  if (id) {
    const next = `${id}-full`;
    for (const el of [copy, ...copy.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) if (attr.value.includes(id)) el.setAttribute(attr.name, attr.value.split(id).join(next));
      if (el.tagName.toLowerCase() === 'style' && el.textContent) el.textContent = el.textContent.split(id).join(next);
    }
  }
  copy.style.transform = '';
  copy.style.maxWidth = 'none';
  return copy;
}

/** Sizes the copy to fit the stage (at most MAX_FIT times its natural size). */
function fit(stage: HTMLElement): void {
  const svg = svgOf(stage);
  if (!svg) return;
  const vb = svg.viewBox.baseVal;
  const w = vb && vb.width > 0 ? vb.width : svg.getBoundingClientRect().width;
  const h = vb && vb.height > 0 ? vb.height : svg.getBoundingClientRect().height;
  if (!(w > 0 && h > 0)) return;
  const s = Math.min((stage.clientWidth - 2 * FIT_PADDING) / w, (stage.clientHeight - 2 * FIT_PADDING) / h, MAX_FIT);
  svg.style.width = `${Math.max(1, w * s)}px`;
  svg.style.height = `${Math.max(1, h * s)}px`;
}

function showCopy(fv: FullView, pre: HTMLElement): void {
  const svg = svgOf(pre);
  if (!svg) return;
  fv.source = pre;
  svgOf(fv.target.box)?.remove();
  fv.target.box.append(copySvg(svg));
  fit(fv.target.box);
  apply(fv.target);
}

function openFull(pre: HTMLElement): void {
  closeFull();
  const content = pre.closest<HTMLElement>('#rm-content') ?? document.body;
  const blocks = [...content.querySelectorAll<HTMLElement>(DIAGRAM)].filter((b) => !b.closest(REMOVED_SELECTOR));
  const index = blocks.indexOf(pre);

  const overlay = document.createElement('div');
  overlay.className = 'rm-diagram-full';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Diagram, full screen');
  const stage = document.createElement('div');
  stage.className = 'rm-diagram-stage';
  stage.tabIndex = -1;
  const hint = document.createElement('div');
  hint.className = 'rm-diagram-hint';
  hint.textContent = 'Wheel to zoom · drag to pan · 0 fits · Esc closes';
  const target: Target = { box: stage, view: { scale: 1, x: 0, y: 0 } };
  overlay.append(stage, makeToolbar(stage, 'Fit to window (0)', [['close', '✕', 'Close (Esc)']]), hint);
  document.body.append(overlay);

  const resize = new ResizeObserver(() => {
    fit(stage);
    apply(target);
  });
  full = { overlay, target, source: pre, key: lastKeys[index] ?? '', index, resize };
  showCopy(full, pre);
  resize.observe(stage);

  overlay.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.rm-zoom button');
    if (!b) return;
    if (b.dataset.zoom === 'close') closeFull();
    else zoomButton(target, b.dataset.zoom);
  });
  overlay.addEventListener('wheel', (e) => wheelZoom(target, e), { passive: false });
  stage.addEventListener('pointerdown', (e) => {
    if (e.button === 0) startPan(target, e);
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') closeFull();
    // Arrows also pan on the toolbar buttons; + - 0 there would only duplicate them.
    else if (!zoomKey(target, e, true)) return;
    e.preventDefault();
    e.stopPropagation();
  });
  stage.focus({ preventScroll: true });
}

function closeFull(): void {
  if (!full) return;
  const { overlay, resize, source } = full;
  full = undefined;
  resize.disconnect();
  overlay.remove();
  if (source.isConnected) source.focus({ preventScroll: true });
}

/** After a render: show the diagram's new SVG, found by key, else by position (source edited). */
function refreshFull(blocks: HTMLElement[], keys: string[]): void {
  if (!full) return;
  let i = keys.indexOf(full.key);
  if (i < 0 && full.index < blocks.length) i = full.index;
  if (i < 0) return closeFull();
  full.key = keys[i];
  full.index = i;
  // Every document render brings new SVG elements (from the cache), so always re-copy; the view stays.
  showCopy(full, blocks[i]);
}
