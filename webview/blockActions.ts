// Hover tools for top-level blocks (elements with `data-line-end`). One floating rail sits in the
// left gutter of the hovered block: a ⋮⋮ handle that opens a menu with the less frequent actions,
// followed by buttons for the primary ones. Features register actions here instead of placing
// their own buttons, so controls never overlap. The rail keeps clear of a heading's fold chevron,
// which stays inline in the heading because it must remain visible while a section is collapsed.
//
// Layout, left to right:  [⋮⋮ handle] [rail actions…] [fold (headings only)] block
// For a list, the rail also keeps clear of the list item grip (see listDrag.ts).
// The handle is also the intended grip for drag-to-reorder.
import { itemGripLeft } from './listDrag';

export interface BlockAction {
  id: string;
  label: string;
  /** 'rail' = button beside the block; 'menu' = item in the ⋮⋮ menu. */
  placement: 'rail' | 'menu';
  /** Text glyph shown on a rail button (menu items show `label`). */
  icon?: string;
  /** Whether the action applies to this block right now. Default: always. */
  when?: (block: HTMLElement) => boolean;
  run: (block: HTMLElement) => void;
}

/** Space between the rail and the block (or the heading's fold button). */
const GAP = 4;
const HIDE_DELAY_MS = 400;

const actions: BlockAction[] = [];
let content: HTMLElement;
let enabled = false;
let rail: HTMLElement;
let railButtons: HTMLElement;
let handle: HTMLButtonElement;
let menu: HTMLElement;
let target: HTMLElement | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export function initBlockActions(root: HTMLElement): void {
  content = root;

  rail = document.createElement('div');
  rail.className = 'rm-block-rail';
  rail.hidden = true;

  handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'rm-block-handle';
  handle.title = 'Block actions';
  handle.setAttribute('aria-label', 'Block actions');
  handle.setAttribute('aria-haspopup', 'menu');
  handle.setAttribute('aria-expanded', 'false');
  handle.append(gripIcon());
  handle.addEventListener('click', (e) => {
    e.preventDefault();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  railButtons = document.createElement('span');
  railButtons.className = 'rm-block-rail-actions';
  rail.append(handle, railButtons);

  menu = document.createElement('div');
  menu.className = 'rm-block-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  menu.addEventListener('keydown', onMenuKey);

  document.body.append(rail, menu);

  document.addEventListener('mouseover', (e) => {
    if (!enabled || !menu.hidden) return;
    const el = e.target as Element;
    if (rail.contains(el)) {
      clearTimeout(hideTimer);
      return;
    }
    const block = findBlock(el);
    if (block && show(block)) return;
    // Delay hiding so the pointer can travel from the block across the gutter to the rail.
    scheduleHide();
  });

  document.addEventListener('pointerdown', (e) => {
    if (menu.hidden) return;
    const el = e.target as Node;
    if (!menu.contains(el) && !handle.contains(el)) {
      closeMenu();
      scheduleHide();
    }
  });

  window.addEventListener('resize', hideBlockActions);
}

export function registerBlockAction(action: BlockAction): void {
  actions.push(action);
}

/** Block tools are offered only in edit mode, so plain reading stays free of hover chrome. */
export function setBlockActionsEnabled(value: boolean): void {
  enabled = value;
  document.body.classList.toggle('rm-block-tools', value);
  if (!value) hideBlockActions();
}

/** Hides the rail and its menu, e.g. before the content is replaced. */
export function hideBlockActions(): void {
  clearTimeout(hideTimer);
  closeMenu();
  rail.hidden = true;
  target = undefined;
}

function findBlock(el: Element): HTMLElement | undefined {
  const block = el.closest<HTMLElement>('[data-line-end]');
  if (!block || !content.contains(block) || block.closest('.rm-edit')) return undefined;
  return block;
}

function applies(action: BlockAction, block: HTMLElement): boolean {
  return action.when?.(block) ?? true;
}

/** Shows the rail for `block`. Returns false if no action applies to it. */
function show(block: HTMLElement): boolean {
  clearTimeout(hideTimer);
  if (block === target && !rail.hidden) return true;

  const railActions = actions.filter((a) => a.placement === 'rail' && applies(a, block));
  const hasMenu = actions.some((a) => a.placement === 'menu' && applies(a, block));
  if (!railActions.length && !hasMenu) {
    hideBlockActions();
    return false;
  }

  target = block;
  handle.hidden = !hasMenu;
  railButtons.replaceChildren(...railActions.map(railButton));
  rail.hidden = false;
  place(block);
  return true;
}

function railButton(action: BlockAction): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rm-block-action';
  b.dataset.action = action.id;
  b.textContent = action.icon ?? action.label;
  b.title = action.label;
  b.setAttribute('aria-label', action.label);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    const block = target;
    if (!block) return;
    hideBlockActions();
    action.run(block);
  });
  return b;
}

function place(block: HTMLElement): void {
  const rect = block.getBoundingClientRect();
  // A heading's fold button hangs in the gutter: end the rail left of it and centre on it.
  const fold = block.classList.contains('rm-heading') ? block.querySelector(':scope > .rm-fold') : null;
  const foldRect = fold?.getBoundingClientRect();
  const hasFold = !!foldRect && foldRect.width > 0;
  let right = hasFold ? Math.min(rect.left, foldRect.left) : rect.left;
  if (block.tagName === 'UL' || block.tagName === 'OL') right = Math.min(right, itemGripLeft(block));
  const top = hasFold ? foldRect.top + (foldRect.height - rail.offsetHeight) / 2 : rect.top;
  rail.style.left = `${Math.max(2, right - GAP - rail.offsetWidth + window.scrollX)}px`;
  rail.style.top = `${top + window.scrollY}px`;
}

function scheduleHide(): void {
  if (rail.hidden) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideBlockActions, HIDE_DELAY_MS);
}

// ---- menu --------------------------------------------------------------------------------

function openMenu(): void {
  const block = target;
  if (!block) return;
  const items = actions
    .filter((a) => a.placement === 'menu' && applies(a, block))
    .map((action) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.dataset.action = action.id;
      b.textContent = action.label;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        hideBlockActions();
        action.run(block);
      });
      return b;
    });
  if (!items.length) return;
  menu.replaceChildren(...items);
  menu.hidden = false;
  handle.setAttribute('aria-expanded', 'true');

  const r = handle.getBoundingClientRect();
  const left = Math.min(r.left, document.documentElement.clientWidth - menu.offsetWidth - 4);
  menu.style.left = `${Math.max(4, left) + window.scrollX}px`;
  menu.style.top = `${r.bottom + 4 + window.scrollY}px`;
  items[0].focus({ preventScroll: true });
}

function closeMenu(): void {
  if (menu.hidden) return;
  const hadFocus = menu.contains(document.activeElement);
  menu.hidden = true;
  menu.replaceChildren();
  handle.setAttribute('aria-expanded', 'false');
  if (hadFocus && !rail.hidden) handle.focus({ preventScroll: true });
}

function onMenuKey(e: KeyboardEvent): void {
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  let next: number | undefined;
  switch (e.key) {
    case 'ArrowDown':
      next = (i + 1) % items.length;
      break;
    case 'ArrowUp':
      next = (i - 1 + items.length) % items.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = items.length - 1;
      break;
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      return;
    case 'Tab':
      closeMenu();
      return;
    default:
      return;
  }
  e.preventDefault();
  items[next]?.focus({ preventScroll: true });
}

function gripIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 6 10');
  svg.setAttribute('width', '6');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cx, cy] of [[1, 1], [5, 1], [1, 5], [5, 5], [1, 9], [5, 9]]) {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', '1');
    dot.setAttribute('fill', 'currentColor');
    svg.append(dot);
  }
  return svg;
}
