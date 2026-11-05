import { post } from './api';

export function decorateCodeBlocks(root: HTMLElement, copyButton: boolean): void {
  if (!copyButton) return;
  for (const pre of root.querySelectorAll<HTMLPreElement>('pre.rm-code')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rm-copy';
    button.textContent = 'Copy';
    button.title = 'Copy code';
    pre.append(button);
  }
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
