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

export function buildSections(root: HTMLElement, opts: SectionOptions): void {
  if (!opts.collapsible) return;
  const frag = document.createDocumentFragment();
  const stack: { level: number; body: HTMLElement }[] = [];

  for (const child of [...root.children] as HTMLElement[]) {
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
    if (collapsed) setCollapsed(section, true);
  }
  root.replaceChildren(frag);
}

export function setCollapsed(section: Element, collapsed: boolean): void {
  section.classList.toggle('rm-collapsed', collapsed);
  section.querySelector(':scope > .rm-heading > .rm-fold')?.setAttribute('aria-expanded', String(!collapsed));
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
      setCollapsed(section, false);
      changed = true;
    }
    el = section.parentElement;
  }
  return changed;
}

export function setAllCollapsed(root: HTMLElement, collapsed: boolean): void {
  root.querySelectorAll('section.rm-section').forEach((s) => setCollapsed(s, collapsed));
}

export function collapsedSlugs(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('section.rm-section.rm-collapsed')].map((s) => s.dataset.slug ?? '').filter(Boolean);
}
