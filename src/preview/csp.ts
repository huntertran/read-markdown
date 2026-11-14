export interface CspOptions {
  /** `webview.cspSource`: the origin the extension's own files (preview.css, main.js, images next to the document) load from. */
  cspSource: string;
  /** Base64 nonce of the one script tag. */
  nonce: string;
  /** `readMarkdown.security.allowRemoteContent`: whether `https:` images and media may load. */
  allowRemoteContent: boolean;
}

/**
 * Content-Security-Policy of the preview webview. Pure (no `vscode`) so it can be unit-tested.
 *
 * - `style-src` allows inline styles (the shell's `<style>` blocks, `style` attributes from the webview, Mermaid and
 *   highlight output, and `<style>` / `style` written in the document) and the extension's own stylesheet, but never
 *   a remote origin: a document or custom CSS cannot `@import` remote CSS.
 * - `font-src` likewise has no remote origin, so a remote `@font-face` does not load.
 * - `img-src` / `media-src` take `https:` only when remote content is allowed. These directives also govern
 *   `url()` in CSS (`background-image`, `cursor`, ...).
 * - Everything else (`connect-src`, `frame-src`, `object-src`, ...) falls back to `default-src 'none'`.
 */
export function buildCsp({ cspSource, nonce, allowRemoteContent }: CspOptions): string {
  const remote = allowRemoteContent ? ' https:' : '';
  return [
    `default-src 'none'`,
    `img-src ${cspSource}${remote} data: blob:`,
    `media-src ${cspSource}${remote} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join('; ');
}
