// Quick navigation sidebar: heading outline with filter and active-section tracking.
import type { Heading } from '../src/protocol';
import type { TaskCounts } from './taskProgress';

let list: HTMLOListElement;
let empty: HTMLElement;
let filterInput: HTMLInputElement;
let content: HTMLElement;
let headings: Heading[] = [];
let items: HTMLLIElement[] = [];
let activeSlug = '';

export function initNav(opts: {
  list: HTMLOListElement;
  empty: HTMLElement;
  filter: HTMLInputElement;
  content: HTMLElement;
  onNavigate: (slug: string) => void;
}): void {
  list = opts.list;
  empty = opts.empty;
  filterInput = opts.filter;
  content = opts.content;
  filterInput.addEventListener('input', applyFilter);
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      filterInput.value = '';
      applyFilter();
    } else if (e.key === 'Enter') {
      const first = items.find((li) => !li.hidden);
      if (first?.dataset.slug) opts.onNavigate(first.dataset.slug);
    }
  });
  list.addEventListener('click', (e) => {
    const a = (e.target as Element).closest('a');
    if (!a) return;
    e.preventDefault();
    const slug = a.parentElement?.dataset.slug;
    if (slug) opts.onNavigate(slug);
  });
}

export function setHeadings(next: Heading[], maxDepth: number): void {
  headings = next.filter((h) => h.level <= maxDepth);
  const minLevel = Math.min(...headings.map((h) => h.level), 6);
  items = headings.map((h) => {
    const li = document.createElement('li');
    li.className = 'rm-nav-item';
    li.dataset.level = String(h.level);
    li.dataset.slug = h.slug;
    li.style.setProperty('--indent', String(h.level - minLevel));
    const a = document.createElement('a');
    a.href = `#${encodeURIComponent(h.slug)}`;
    a.textContent = h.text || '(untitled)';
    a.title = h.text;
    li.append(a);
    return li;
  });
  list.replaceChildren(...items);
  empty.hidden = items.length > 0;
  activeSlug = '';
  applyFilter();
  updateActive();
}

/** Done/total task counts beside outline headings, with a pulsing dot while a step is in progress. */
export function setTaskBadges(counts: ReadonlyMap<string, TaskCounts> | undefined): void {
  for (const li of items) {
    li.querySelector(':scope > .rm-nav-tasks')?.remove();
    const c = counts?.get(li.dataset.slug ?? '');
    li.classList.toggle('rm-nav-has-tasks', !!c);
    if (!c) continue;
    const badge = document.createElement('span');
    badge.className = 'rm-nav-tasks';
    badge.classList.toggle('rm-nav-tasks-active', c.active > 0);
    badge.classList.toggle('rm-nav-tasks-complete', c.done === c.total);
    badge.textContent = `${c.done}/${c.total}`;
    badge.title = `${c.done} of ${c.total} tasks done` + (c.active ? `, ${c.active} in progress` : '');
    li.append(badge);
  }
}

function applyFilter(): void {
  const q = filterInput.value.trim().toLowerCase();
  items.forEach((li, i) => {
    li.hidden = !!q && !headings[i].text.toLowerCase().includes(q);
  });
}

/** Marks the heading of the section currently at the top of the viewport. */
export function updateActive(): void {
  if (!items.length) return;
  const threshold = Math.min(120, window.innerHeight / 4);
  let slug = headings[0]?.slug ?? '';
  for (const h of headings) {
    const el = document.getElementById(h.slug);
    if (!el || !content.contains(el) || el.getClientRects().length === 0) continue;
    if (el.getBoundingClientRect().top <= threshold) slug = h.slug;
    else break;
  }
  if (slug === activeSlug) return;
  activeSlug = slug;
  for (const li of items) {
    const active = li.dataset.slug === slug;
    li.classList.toggle('rm-active', active);
    if (active) li.scrollIntoView({ block: 'nearest' });
  }
}
