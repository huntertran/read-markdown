import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Static shell of the preview. Content arrives later via postMessage. */
// Codicons "collapse-all" / "expand-all" (https://github.com/microsoft/vscode-codicons, CC BY 4.0).
const COLLAPSE_ALL_ICON =
  '<svg class="rm-icon-collapse" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14 4.27051C14.5999 4.62053 15 5.26009 15 6V11C15 13.21 13.21 15 11 15H6C5.26009 15 4.62053 14.5999 4.27051 14H11C12.65 14 14 12.65 14 11V4.27051Z"/><path d="M9.5 7C9.776 7 10 7.224 10 7.5C10 7.776 9.776 8 9.5 8H5.5C5.224 8 5 7.776 5 7.5C5 7.224 5.224 7 5.5 7H9.5Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M11 2C12.103 2 13 2.897 13 4V11C13 12.103 12.103 13 11 13H4C2.897 13 2 12.103 2 11V4C2 2.897 2.897 2 4 2H11ZM4 3C3.449 3 3 3.449 3 4V11C3 11.552 3.449 12 4 12H11C11.551 12 12 11.552 12 11V4C12 3.449 11.551 3 11 3H4Z"/></svg>';
const EXPAND_ALL_ICON =
  '<svg class="rm-icon-expand" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M15 6V11C15 13.21 13.21 15 11 15H6C5.26 15 4.62 14.6 4.27 14H11C12.65 14 14 12.65 14 11V4.27C14.6 4.62 15 5.26 15 6ZM11 13H4C2.897 13 2 12.103 2 11V4C2 2.897 2.897 2 4 2H11C12.103 2 13 2.897 13 4V11C13 12.103 12.103 13 11 13ZM4 12H11C11.551 12 12 11.552 12 11V4C12 3.449 11.551 3 11 3H4C3.449 3 3 3.449 3 4V11C3 11.552 3.449 12 4 12ZM9.5 7H8V5.5C8 5.224 7.776 5 7.5 5C7.224 5 7 5.224 7 5.5V7H5.5C5.224 7 5 7.224 5 7.5C5 7.776 5.224 8 5.5 8H7V9.5C7 9.776 7.224 10 7.5 10C7.776 10 8 9.776 8 9.5V8H9.5C9.776 8 10 7.776 10 7.5C10 7.224 9.776 7 9.5 7Z"/></svg>';

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, documentUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p)).toString();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `media-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline' https:`,
    `font-src ${webview.cspSource} https: data:`,
    `script-src 'nonce-${nonce}'`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media('media', 'preview.css')}">
  <style id="rm-vars"></style>
  <style id="rm-custom"></style>
</head>
<body data-uri="${escapeAttr(documentUri.toString())}" data-mermaid-src="${escapeAttr(media('dist', 'media', 'mermaid.min.js'))}" data-nonce="${nonce}">
  <div id="rm-app">
    <nav id="rm-nav" aria-label="Document outline">
      <div class="rm-nav-header">
        <input id="rm-nav-filter" type="search" placeholder="Filter headings" aria-label="Filter headings" spellcheck="false">
        <div class="rm-nav-actions">
          <button id="rm-fold-all" class="rm-icon-btn" data-mode="collapse" title="Collapse all sections" aria-label="Collapse all sections" hidden>
            ${COLLAPSE_ALL_ICON}${EXPAND_ALL_ICON}
          </button>
        </div>
      </div>
      <ol id="rm-nav-list"></ol>
      <div id="rm-nav-empty" hidden>No headings</div>
    </nav>
    <main id="rm-main">
      <article id="rm-content" class="rm-markdown"></article>
    </main>
  </div>
  <div id="rm-toolbar">
    <span id="rm-search-badge" hidden></span>
    <button id="rm-toggle-nav" class="rm-icon-btn" title="Toggle quick navigation" aria-label="Toggle quick navigation">&#x2630;</button>
    <button id="rm-top" class="rm-icon-btn" title="Back to top" aria-label="Back to top">&#x2191;</button>
    <button id="rm-open-settings" class="rm-icon-btn" title="Reading settings" aria-label="Reading settings">&#x2699;</button>
  </div>
  <div id="rm-settings" role="dialog" aria-label="Reading settings" hidden></div>
  <script nonce="${nonce}" src="${media('dist', 'media', 'main.js')}"></script>
</body>
</html>`;
}
