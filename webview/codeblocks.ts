import { post } from './api';
import { REMOVED_SELECTOR } from './changes';

export interface CodeBlockOptions {
  copyButton: boolean;
  /** Line numbers beside the code (`readMarkdown.code.lineNumbers`). */
  lineNumbers: boolean;
}

export function decorateCodeBlocks(root: HTMLElement, opts: CodeBlockOptions): void {
  if (!opts.copyButton && !opts.lineNumbers) return;
  for (const pre of root.querySelectorAll<HTMLPreElement>('pre.rm-code')) {
    if (pre.closest(REMOVED_SELECTOR)) continue;
    if (opts.lineNumbers) addLineNumbers(pre);
    if (!opts.copyButton) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rm-copy';
    button.textContent = 'Copy';
    button.title = 'Copy code';
    pre.append(button);
  }
}

/** Lines of a code block's text: the final line break ends the last line, it does not start one. */
export function codeLineCount(text: string): number {
  return text.replace(/\r?\n$/, '').split('\n').length;
}

/**
 * A gutter of empty rows in front of the code, numbered by CSS counters (`.rm-code-lines`): the
 * numbers are not DOM text, so search, the find widget, selection and Copy never see them.
 */
function addLineNumbers(pre: HTMLPreElement): void {
  const code = pre.querySelector(':scope > code');
  if (!code) return;
  const gutter = document.createElement('span');
  gutter.className = 'rm-code-lines';
  gutter.setAttribute('aria-hidden', 'true');
  const count = codeLineCount(code.textContent ?? '');
  for (let i = 0; i < count; i++) gutter.append(document.createElement('span'));
  pre.classList.add('rm-numbered');
  pre.insertBefore(gutter, code);
}

export function initCodeBlocks(root: HTMLElement): void {
  root.addEventListener('click', (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('button.rm-copy');
    if (!button) return;
    e.preventDefault();
    const code = button.parentElement?.querySelector('code');
    if (!code) return;
    post({ type: 'copy', text: code.textContent ?? '' });
    button.textContent = 'Copied';
    button.classList.add('rm-copied');
    setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('rm-copied');
    }, 1500);
  });
}
