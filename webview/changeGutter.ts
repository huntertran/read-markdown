// Change bars beside the content (like the editor's quick-diff gutter) for elements tagged by
// `changes.ts`, plus the jump buttons and hover pairing of moved blocks. The bars live in an overlay
// in #rm-main (outside #rm-content, which is replaced on every render) and never take pointer events.
// The same changes are also marked on the scrollbar (overview ruler, like the editor's).
import { CHANGED_SELECTOR } from './changes';
import { expandTo } from './sections';
import { invalidate } from './scroll';

type BarKind = 'added' | 'modified' | 'deleted' | 'moved' | 'removed';

let content: HTMLElement;
let main: HTMLElement;
let overlay: HTMLElement;
let ruler: HTMLElement;
let frame = 0;

export function initChangeGutter(contentEl: HTMLElement, mainEl: HTMLElement): void {
  content = contentEl;
  main = mainEl;
  overlay = document.createElement('div');
  overlay.id = 'rm-change-gutter';
  main.append(overlay);
  ruler = document.createElement('style');
  ruler.id = 'rm-change-ruler';
  document.head.append(ruler);
  // The viewport height changes the ruler's scale.
  window.addEventListener('resize', scheduleChangeGutter);

  // Sections folding, images and diagrams loading, nav resizing: anything that moves blocks.
  const observer = new ResizeObserver(() => scheduleChangeGutter());
  observer.observe(content);
  observer.observe(main);

  overlay.addEventListener('click', (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('button.rm-move-jump');
    if (button?.dataset.moveId) jumpToPartner(button.dataset.moveId, button.dataset.side === 'from' ? 'to' : 'from');
  });

  // Hovering one end of a move outlines the other.
  content.addEventListener('mouseover', (e) => setPair((e.target as Element).closest<HTMLElement>('[data-move-id]')?.dataset.moveId));
  content.addEventListener('mouseleave', () => setPair(undefined));
}

let pairId: string | undefined;

function setPair(id: string | undefined): void {
  if (id === pairId) return;
  pairId = id;
  for (const el of content.querySelectorAll('.rm-chg-pair')) el.classList.remove('rm-chg-pair');
  if (id) for (const el of content.querySelectorAll(`[data-move-id="${CSS.escape(id)}"]`)) el.classList.add('rm-chg-pair');
  for (const arrow of overlay.querySelectorAll<SVGGElement>('.rm-move-arrow')) arrow.classList.toggle('rm-move-arrow-active', arrow.dataset.moveId === id);
}

function jumpToPartner(id: string, side: 'from' | 'to'): void {
  const selector = `[data-move-id="${CSS.escape(id)}"]`;
  const target = content.querySelector<HTMLElement>(`${selector}.${side === 'from' ? 'rm-chg-move-from' : 'rm-chg-move-to'}`);
  if (!target) return;
  if (expandTo(target)) invalidate();
  // User-initiated: let the scroll propagate to the source editor like outline navigation does.
  window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3, behavior: 'instant' });
  target.classList.remove('rm-chg-flash');
  void target.offsetWidth; // restart the animation
  target.classList.add('rm-chg-flash');
}

export function scheduleChangeGutter(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    updateChangeGutter();
  });
}

export function updateChangeGutter(): void {
  if (!overlay) return;
  const bars = document.createDocumentFragment();
  const base = main.getBoundingClientRect();
  const box = content.getBoundingClientRect();
  const left = box.left - base.left;
  const right = box.right - base.left;

  const marks: RulerMark[] = [];

  for (const el of content.querySelectorAll<HTMLElement>(CHANGED_SELECTOR)) {
    // One bar per change: nested tagged elements are covered by their tagged ancestor.
    if (el.parentElement?.closest(CHANGED_SELECTOR) && content.contains(el.parentElement)) continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue; // inside a collapsed section
    const kind = barKind(el);
    bars.append(bar(kind, left, r.top - base.top, r.height));
    marks.push({ kind, top: r.top + window.scrollY, height: r.height });
    const id = el.dataset.moveId;
    const side = el.classList.contains('rm-chg-move-from') ? 'from' : 'to';
    // A jump button only when the other end is shown (inline mode).
    const partner = id ? content.querySelector(`[data-move-id="${CSS.escape(id)}"].rm-chg-move-${side === 'from' ? 'to' : 'from'}`) : null;
    if (id && partner) {
      const down = partner.getBoundingClientRect().top > r.top;
      bars.append(jumpButton(id, side, down, right, r.top - base.top));
    }
  }
  for (const el of content.querySelectorAll<HTMLElement>('[data-rm-del-before], [data-rm-del-after]')) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    const y = el.dataset.rmDelBefore !== undefined ? r.top : r.bottom;
    bars.append(bar('deleted', left, y - base.top, 0));
    marks.push({ kind: 'deleted', top: y + window.scrollY, height: 0 });
  }
  const arrows = moveArrows(left, base.top);
  if (arrows) bars.append(arrows);
  overlay.replaceChildren(bars);
  updateRuler(marks);
}

// ---- overview ruler ---------------------------------------------------------------------------

interface RulerMark {
  kind: BarKind;
  /** Page-relative top and height of the changed block. */
  top: number;
  height: number;
}

/** Marks are at least this tall (px), so a one-line change stays visible in a long document. */
const MARK_MIN_HEIGHT = 3;
/** Ruler colors: VS Code's overview ruler colors, falling back to the change bar colors. */
const RULER_COLORS: Record<'added' | 'modified' | 'deleted', string> = {
  added: 'var(--vscode-editorOverviewRuler-addedForeground, var(--rm-chg-added))',
  modified: 'var(--vscode-editorOverviewRuler-modifiedForeground, var(--rm-chg-modified))',
  deleted: 'var(--vscode-editorOverviewRuler-deletedForeground, var(--rm-chg-deleted))',
};

/**
 * Overview ruler, like the editor's: each change marked on the scrollbar track at the height the
 * thumb has when it is in view. Page elements can't draw over the native scrollbar (fixed
 * positioning stops at it), so the marks are an SVG painted as the track's background; scrolling
 * stays native and the translucent thumb slides over them.
 */
function updateRuler(marks: RulerMark[]): void {
  if (marks.length === 0) {
    ruler.textContent = '';
    return;
  }
  const viewport = window.innerHeight;
  const docHeight = Math.max(document.documentElement.scrollHeight, viewport);
  // SVG in a data URL can't see CSS variables: resolve the colors here.
  const colors = {
    added: resolveColor(RULER_COLORS.added),
    modified: resolveColor(RULER_COLORS.modified),
    deleted: resolveColor(RULER_COLORS.deleted),
  };
  const minHeight = (MARK_MIN_HEIGHT / viewport) * docHeight;
  const rects = marks.map((m) => {
    const color = m.kind === 'added' || m.kind === 'moved' ? colors.added : m.kind === 'modified' ? colors.modified : colors.deleted;
    const height = Math.max(minHeight, m.height);
    const y = Math.max(0, Math.min(docHeight - height, m.height ? m.top : m.top - height / 2));
    return `<rect x="0" y="${y.toFixed(1)}" width="1" height="${height.toFixed(1)}" fill="${color}"/>`;
  });
  // Document coordinates, stretched to the track's size.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 ${docHeight.toFixed(0)}" preserveAspectRatio="none">${rects.join('')}</svg>`;
  // VS Code's webview styles set the standard `scrollbar-color` on <html>, which makes Chromium
  // ignore all `::-webkit-scrollbar*` rules for the page scrollbar; `auto` brings them back (VS Code
  // styles the thumb that way too). The value is inherited, so <body> gets VS Code's own value back
  // and scrollbars inside the page (outline, code blocks, textarea) look as before. The page's
  // scrollbar only takes the unscoped selector (`html::` does not match it); inner tracks are reset.
  ruler.textContent =
    'html { scrollbar-color: auto; }\n' +
    'body { scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background); }\n' +
    `::-webkit-scrollbar-track { background: url("data:image/svg+xml,${encodeURIComponent(svg)}") no-repeat center / 100% 100%; }\n` +
    'body *::-webkit-scrollbar-track { background: none; }';
}

let probe: HTMLElement | undefined;

/** A CSS color expression (with variables) as the `rgb()` / `rgba()` the browser computes for it. */
function resolveColor(value: string): string {
  if (!probe) {
    probe = document.createElement('span');
    probe.hidden = true;
    document.body.append(probe);
  }
  probe.style.color = '';
  probe.style.color = value;
  return getComputedStyle(probe).color;
}

// ---- move arrows ----------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Arrow lanes left of the bars; overlapping moves take different lanes (cycling after MAX_LANES). */
const LANE_START = 20;
const LANE_GAP = 6;
const MAX_LANES = 4;
/** Where the arrow leaves / enters, just left of the change bar (which sits 12px left of the text). */
const END_OFFSET = 15;
const HEAD = 4;

/**
 * Inline mode: a connector in the left gutter from each moved-from block to its moved-to block
 * (vertical centers), with an arrowhead at the new location.
 */
function moveArrows(left: number, top: number): SVGSVGElement | undefined {
  const pairs: { id: string; y1: number; y2: number }[] = [];
  for (const from of content.querySelectorAll<HTMLElement>('.rm-chg-move-from[data-move-id]')) {
    const id = from.dataset.moveId!;
    const to = content.querySelector<HTMLElement>(`.rm-chg-move-to[data-move-id="${CSS.escape(id)}"]`);
    if (!to) continue;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    if (a.height === 0 || b.height === 0) continue; // an end is folded away
    pairs.push({ id, y1: a.top + a.height / 2 - top, y2: b.top + b.height / 2 - top });
  }
  if (pairs.length === 0) return undefined;

  // Greedy interval colouring: shortest spans get the innermost lanes.
  pairs.sort((p, q) => Math.abs(p.y2 - p.y1) - Math.abs(q.y2 - q.y1));
  const lanes: [number, number][][] = [];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('rm-move-arrows');
  svg.setAttribute('aria-hidden', 'true');
  for (const p of pairs) {
    const lo = Math.min(p.y1, p.y2);
    const hi = Math.max(p.y1, p.y2);
    let lane = lanes.findIndex((spans) => spans.every(([s, e]) => hi < s || lo > e));
    if (lane < 0) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane].push([lo, hi]);

    const x0 = left - END_OFFSET;
    const xl = left - LANE_START - (lane % MAX_LANES) * LANE_GAP;
    const dir = p.y2 >= p.y1 ? 1 : -1;
    const r = Math.min(4, Math.abs(p.y2 - p.y1) / 2, (x0 - xl) / 2);
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute(
      'd',
      `M ${x0} ${p.y1} H ${xl + r} Q ${xl} ${p.y1} ${xl} ${p.y1 + dir * r} V ${p.y2 - dir * r} Q ${xl} ${p.y2} ${xl + r} ${p.y2} H ${x0}`,
    );
    const head = document.createElementNS(SVG_NS, 'path');
    head.setAttribute('d', `M ${x0 - HEAD} ${p.y2 - HEAD} L ${x0} ${p.y2} L ${x0 - HEAD} ${p.y2 + HEAD}`);
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('rm-move-arrow');
    if (p.id === pairId) g.classList.add('rm-move-arrow-active');
    g.dataset.moveId = p.id;
    g.append(line, head);
    svg.append(g);
  }
  return svg;
}

function barKind(el: HTMLElement): BarKind {
  const c = el.classList;
  if (c.contains('rm-chg-move-from')) return 'removed';
  if (c.contains('rm-chg-move-to')) return 'moved';
  if (c.contains('rm-chg-del')) return 'removed';
  if (c.contains('rm-chg-ins')) return 'added';
  return 'modified';
}

function bar(kind: BarKind, x: number, y: number, height: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'rm-chg-bar';
  el.dataset.kind = kind;
  el.setAttribute('aria-hidden', 'true');
  el.style.transform = `translate(${x}px, ${y}px)`;
  if (height) el.style.height = `${height}px`;
  return el;
}

function jumpButton(id: string, side: 'from' | 'to', down: boolean, x: number, y: number): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rm-move-jump';
  b.dataset.moveId = id;
  b.dataset.side = side;
  b.textContent = down ? '↓' : '↑';
  b.title = side === 'from' ? 'Moved: go to the new location' : 'Moved: go to the old location';
  b.setAttribute('aria-label', b.title);
  b.style.transform = `translate(${x}px, ${y}px)`;
  return b;
}
