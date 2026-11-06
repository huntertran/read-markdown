// Drag handle on the inner edge of the quick navigation. The width is previewed live through an
// inline --rm-nav-width override and saved to `readMarkdown.nav.width` when the drag ends, so it
// is remembered across previews and sessions. The override is dropped once the new config arrives.
import { post } from './api';

// Same bounds as `readMarkdown.nav.width` in package.json and `validateQuickSetting`.
const MIN_WIDTH = 120;
const MAX_WIDTH = 600;
const KEY_STEP = 16;
const KEY_SAVE_DELAY_MS = 500;

let nav: HTMLElement;
let handle: HTMLElement;
let dragging = false;
let moved = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const clamp = (w: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
const isRight = () => document.body.dataset.navPosition === 'right';
const currentWidth = () => Math.round(nav.getBoundingClientRect().width);

function previewWidth(width: number): void {
  document.documentElement.style.setProperty('--rm-nav-width', `${width}px`);
  handle.setAttribute('aria-valuenow', String(width));
}

function save(value: number | ''): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  post({ type: 'updateSetting', key: 'nav.width', value });
}

export function initNavResize(navEl: HTMLElement, handleEl: HTMLElement): void {
  nav = navEl;
  handle = handleEl;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    moved = false;
    document.body.classList.add('rm-nav-resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = nav.getBoundingClientRect();
    previewWidth(clamp(isRight() ? r.right - e.clientX : e.clientX - r.left));
    moved = true;
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('rm-nav-resizing');
    // A plain click (or the clicks of a double-click) must not write the setting.
    if (moved) save(currentWidth());
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('lostpointercapture', endDrag);

  // Double-click resets to the default width (removes the setting).
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--rm-nav-width');
    save('');
  });

  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    // Arrow keys move the edge, so on a right-hand outline ArrowLeft makes it wider.
    const grow = (e.key === 'ArrowRight') !== isRight();
    previewWidth(clamp(currentWidth() + (grow ? KEY_STEP : -KEY_STEP)));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(currentWidth()), KEY_SAVE_DELAY_MS);
  });
}

/** Called after each config message: the settings CSS now carries the saved width. */
export function syncNavWidth(): void {
  if (!nav || dragging || saveTimer) return;
  document.documentElement.style.removeProperty('--rm-nav-width');
  handle.setAttribute('aria-valuenow', String(currentWidth()));
}
