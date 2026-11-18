// "Go to Line" in the preview (`readMarkdown.goToLine`): the element that shows a source line, and a
// short flash on it so the eye finds the target after the jump.

/**
 * The innermost rendered element whose source starts closest at or before `line`: the largest `data-line`
 * not past it; on a tie the later one in document order, which is the nested one (a list item after its
 * list). Track-changes clones carry no `data-line`, so they are never picked.
 */
export function lineTarget(root: ParentNode, line: number): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let bestLine = -1;
  for (const el of root.querySelectorAll<HTMLElement>('[data-line]')) {
    const l = Number(el.dataset.line);
    if (!Number.isFinite(l) || l > line || l < bestLine) continue;
    best = el;
    bestLine = l;
  }
  return best;
}

export function flashLineTarget(el: HTMLElement): void {
  el.classList.remove('rm-goto-flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('rm-goto-flash');
  el.addEventListener('animationend', () => el.classList.remove('rm-goto-flash'), { once: true });
}
