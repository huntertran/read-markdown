/**
 * What `webview.asWebviewUri(uri).toString()` returns for `path` relative to a document in `d:/docs`: every path
 * segment percent-encoded the way VS Code's `Uri.toString` does it (it keeps only `A-Z a-z 0-9 - . _ ~` and `/`).
 * Query and fragment are dropped, as `toUri` in `src/preview/pathContext.ts` does. No `vscode` import.
 */
export function webviewUri(path: string): string {
  const encode = (segment: string) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const bare = path.replace(/[?#].*$/s, '');
  return `https://file%2B.vscode-resource.vscode-cdn.net/d%3A/docs/${bare.split('/').map(encode).join('/')}`;
}
