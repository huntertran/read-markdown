// Wraps each top-level heading and the content after it (until the next heading of the same or
// higher level) into a collapsible <section>.
import { REMOVED_SELECTOR } from './changes';

const HEADING = /^H([1-6])$/;

export interface SectionOptions {
  collapsible: boolean;
  startCollapsedBelowLevel: number;
  /** Slugs collapsed in a previous render; undefined on the very first render of this document. */
  collapsed: ReadonlySet<string> | undefined;
}

const listeners: (() => void)[] = [];

/**
 * Runs `fn` after sections were built, or collapsed/expanded. Every change goes through this
 * module, so the fold-all button needs no DOM observer.
 */
export function onSectionsChange(fn: () => void): void {
  listeners.push(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

export function buildSections(root: HTMLElement, opts: SectionOptions): void {
  buildSectionTree(root, opts);
  notify();
}

/**
 * Appends top-level blocks after the content already in `root` (sections built), as if they had been
 * part of it when `buildSections` ran: each block goes into the innermost section still open at the
 * end, each heading starts a section there. Used to add the rest of a document rendered in two parts.
 */
export function extendSections(root: HTMLElement, nodes: Node[], opts: SectionOptions): void {
  if (!opts.collapsible) {
    root.append(...nodes);
  } else {
    // Like buildSections, which moves elements only (the whitespace between blocks is dropped).
    const blocks = nodes.filter((n): n is HTMLElement => n.nodeType === Node.ELEMENT_NODE);
    // The sections still open at the end: the last section of the root, its last nested section, ...
    const stack: SectionStack = [];
    let parent: Element = root;
    for (;;) {
      const last = parent.lastElementChild;
      const body = last?.matches('section.rm-section') ? last.querySelector<HTMLElement>(':scope > .rm-section-body') : null;
      if (!last || !body) break;
      stack.push({ level: Number((last as HTMLElement).dataset.level), body });
      parent = body;
    }
    placeInSections(blocks, root, stack, opts);
  }
  notify();
}

type SectionStack = { level: number; body: HTMLElement }[];

function buildSectionTree(root: HTMLElement, opts: SectionOptions): void {
  if (!opts.collapsible) return;
  const frag = document.createDocumentFragment();
  placeInSections([...root.children] as HTMLElement[], frag, [], opts);
  root.replaceChildren(frag);
}

/** Moves `blocks` into `top` and the sections they start, continuing the open sections in `stack`. */
function placeInSections(blocks: HTMLElement[], frag: ParentNode, stack: SectionStack, opts: SectionOptions): void {
  for (const child of blocks) {
    // Removed headings (track changes) are shown in place but no longer start a section.
    const m = child.matches(REMOVED_SELECTOR) ? null : HEADING.exec(child.tagName);
    if (!m) {
      (stack.at(-1)?.body ?? frag).append(child);
      continue;
    }
    const level = Number(m[1]);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();

    const section = document.createElement('section');
    section.className = 'rm-section';
    section.dataset.level = String(level);
    section.dataset.slug = child.id;

    child.classList.add('rm-heading');
    const fold = document.createElement('button');
    fold.className = 'rm-fold';
    fold.type = 'button';
    fold.title = 'Collapse / expand section';
    fold.setAttribute('aria-label', 'Collapse or expand section');
    fold.setAttribute('aria-expanded', 'true');
    child.prepend(fold);

    const body = document.createElement('div');
    body.className = 'rm-section-body';
    section.append(child, body);
    (stack.at(-1)?.body ?? frag).append(section);
    stack.push({ level, body });

    const collapsed = opts.collapsed
      ? opts.collapsed.has(child.id)
      : opts.startCollapsedBelowLevel > 0 && level >= opts.startCollapsedBelowLevel;
    if (collapsed) applyCollapsed(section, true);
  }
}

/**
 * The body of a collapsed section. It is hidden with `hidden="until-found"`, not `display: none`, so
 * the find widget (Chromium find-in-page) still searches it and can reveal a match (`revealFound`).
 * Its content therefore keeps layout boxes: code that measures elements must skip it with `isFolded`
 * instead of relying on empty client rects.
 */
const FOLDED = '.rm-collapsed > .rm-section-body';

/** True if `el` is inside the body of a collapsed section (not shown). */
export function isFolded(el: Element): boolean {
  return el.closest(FOLDED) !== null;
}

function applyCollapsed(section: Element, collapsed: boolean): void {
  section.classList.toggle('rm-collapsed', collapsed);
  const body = section.querySelector(':scope > .rm-section-body');
  if (collapsed) body?.setAttribute('hidden', 'until-found');
  else body?.removeAttribute('hidden');
  section.querySelector(':scope > .rm-heading > .rm-fold')?.setAttribute('aria-expanded', String(!collapsed));
}

export function setCollapsed(section: Element, collapsed: boolean): void {
  applyCollapsed(section, collapsed);
  notify();
}

/** Expands every collapsed section that contains `node`. Returns true if anything changed. */
export function expandTo(node: Node | null): boolean {
  let changed = false;
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el) {
    const section: Element | null = el.closest('section.rm-section');
    if (!section) break;
    // A heading stays visible when its own section is collapsed, so that section needs no expanding.
    const ownHeading = section.querySelector(':scope > .rm-heading');
    if (section.classList.contains('rm-collapsed') && !(node && ownHeading?.contains(node))) {
      applyCollapsed(section, false);
      changed = true;
    }
    el = section.parentElement;
  }
  if (changed) notify();
  return changed;
}

/**
 * Handles `beforematch`: the find widget found text in a collapsed section body (`target`) and is
 * about to show it. Expands that section; the event fires once per collapsed ancestor. Returns true
 * if a section was expanded.
 */
export function revealFound(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !target.matches(FOLDED)) return false;
  setCollapsed(target.parentElement!, false);
  return true;
}

export function setAllCollapsed(root: HTMLElement, collapsed: boolean): void {
  root.querySelectorAll('section.rm-section').forEach((s) => applyCollapsed(s, collapsed));
  notify();
}

export function collapsedSlugs(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('section.rm-section.rm-collapsed')].map((s) => s.dataset.slug ?? '').filter(Boolean);
}
