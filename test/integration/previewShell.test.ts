import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getWebviewHtml } from '../../src/preview/html';
import type { PreviewManager } from '../../src/preview/previewManager';
import type { PreviewPanel } from '../../src/preview/previewPanel';

const EXTENSION_ID = 'huntertran.read-markdown';
const REMOTE_KEY = 'security.allowRemoteContent';

let extensionUri: vscode.Uri;
let manager: PreviewManager;

function workspaceFolder(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'fixture workspace must be open');
  return folder.uri;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function openPreview(uri: vscode.Uri): Promise<PreviewPanel> {
  return manager.open(uri, vscode.ViewColumn.Active, false);
}

/** The CSP of the shell, split into directive name -> sources. */
function cspOf(html: string): Map<string, string[]> {
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/g)];
  assert.equal(metas.length, 1, 'exactly one CSP meta tag');
  const policy = new Map<string, string[]>();
  for (const part of metas[0][1].split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) policy.set(name, sources);
  }
  return policy;
}

/** `webview.cspSource` can be several sources (`'self' https://*.vscode-cdn.net`); the directive must list each. */
function assertAllowsOwnOrigin(policy: Map<string, string[]>, directive: string, webview: vscode.Webview): void {
  const own = webview.cspSource.split(/\s+/).filter(Boolean);
  assert.ok(own.length >= 1, 'the webview has a CSP source');
  for (const source of own) assert.ok(policy.get(directive)?.includes(source), `${directive} lacks ${source}`);
}

/** The nonce each `<script>` tag carries (undefined for a tag without one). */
function scriptNonces(html: string): (string | undefined)[] {
  return [...html.matchAll(/<script\b[^>]*>/g)].map((m) => /\snonce="([^"]*)"/.exec(m[0])?.[1]);
}

/** The one nonce of a shell: the `script-src` one, which every script tag must repeat. */
function nonceOf(html: string): string {
  const scriptSrc = cspOf(html).get('script-src') ?? [];
  assert.equal(scriptSrc.length, 1, `script-src: ${scriptSrc.join(' ')}`);
  const m = /^'nonce-(.+)'$/.exec(scriptSrc[0]);
  assert.ok(m, `script-src is not a nonce: ${scriptSrc[0]}`);
  return m[1];
}

describe('Preview webview shell', () => {
  let originalRemote: boolean | undefined;
  const tempDirs: string[] = [];

  before(async () => {
    const ext = vscode.extensions.getExtension<{ manager: PreviewManager }>(EXTENSION_ID);
    assert.ok(ext, 'extension should be installed');
    const api = await ext.activate();
    manager = api.manager;
    extensionUri = ext.extensionUri;
    // Start from the default whatever an earlier run left in the test profile; put it back in `after`.
    originalRemote = vscode.workspace.getConfiguration('readMarkdown').inspect<boolean>(REMOTE_KEY)?.globalValue;
    await vscode.workspace.getConfiguration('readMarkdown').update(REMOTE_KEY, undefined, vscode.ConfigurationTarget.Global);
  });

  after(async () => {
    await vscode.workspace.getConfiguration('readMarkdown').update(REMOTE_KEY, originalRemote, vscode.ConfigurationTarget.Global);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('carries a CSP whose script nonce is the one on every script tag', async () => {
    const preview = await openPreview(vscode.Uri.joinPath(workspaceFolder(), 'long-ai-doc.md'));
    const html = preview.panel.webview.html;

    const policy = cspOf(html);
    const nonce = nonceOf(html);
    assert.ok(nonce.length >= 16, 'the nonce is not trivially short');
    const nonces = scriptNonces(html);
    assert.ok(nonces.length >= 1, 'the shell has a script tag');
    for (const n of nonces) assert.equal(n, nonce, 'every <script> carries the CSP nonce');

    // buildCsp emits exactly `script-src 'nonce-…'`: no inline, eval or remote scripts.
    assert.deepEqual(policy.get('script-src'), [`'nonce-${nonce}'`]);
    assert.ok(![...policy.values()].flat().some((s) => s === `'unsafe-eval'`), 'no unsafe-eval anywhere');
    assert.deepEqual(policy.get('default-src'), [`'none'`]);
    // The directive sources use the origin VS Code gave this very webview.
    for (const d of ['img-src', 'media-src', 'style-src', 'font-src']) assertAllowsOwnOrigin(policy, d, preview.panel.webview);
    // Remote stylesheets and fonts are never allowed.
    for (const d of ['style-src', 'font-src']) assert.ok(!policy.get(d)?.includes('https:'), `${d} has https:`);
  });

  it('allows https: images and media by default and rebuilds the page when the setting changes', async () => {
    const config = vscode.workspace.getConfiguration('readMarkdown');
    assert.equal(config.get(REMOTE_KEY), true, 'the default is on');
    const preview = await openPreview(vscode.Uri.joinPath(workspaceFolder(), 'remote-content.md'));
    const webview = preview.panel.webview;

    const before = webview.html;
    for (const d of ['img-src', 'media-src']) assert.ok(cspOf(before).get(d)?.includes('https:'), `${d} (default)`);

    try {
      await config.update(REMOTE_KEY, false, vscode.ConfigurationTarget.Global);
      await waitFor(() => webview.html !== before, 'the webview HTML to be rebuilt (off)');
      const off = webview.html;
      for (const d of ['img-src', 'media-src']) assert.ok(!cspOf(off).get(d)?.includes('https:'), `${d} (off)`);
      assert.notEqual(nonceOf(off), nonceOf(before), 'a rebuilt page has a new nonce');
      for (const n of scriptNonces(off)) assert.equal(n, nonceOf(off));
      // The new page still allows the extension's own files and data: URIs.
      assertAllowsOwnOrigin(cspOf(off), 'img-src', webview);
      assert.ok(cspOf(off).get('img-src')?.includes('data:'));

      await config.update(REMOTE_KEY, true, vscode.ConfigurationTarget.Global);
      await waitFor(() => webview.html !== off, 'the webview HTML to be rebuilt (on)');
      const on = webview.html;
      for (const d of ['img-src', 'media-src']) assert.ok(cspOf(on).get(d)?.includes('https:'), `${d} (on again)`);
      assert.notEqual(nonceOf(on), nonceOf(off));
      assert.notEqual(nonceOf(on), nonceOf(before));
    } finally {
      await config.update(REMOTE_KEY, undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('limits localResourceRoots to the extension media, the document folder and the workspace', async () => {
    const workspace = workspaceFolder();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-shell-'));
    tempDirs.push(tempDir);
    const outside = path.join(tempDir, 'outside.md');
    fs.writeFileSync(outside, '# Outside the workspace\n');

    const inside = await openPreview(vscode.Uri.joinPath(workspace, 'other.md'));
    // For a document in the workspace the folder and the workspace root coincide, so the root is listed twice.
    assert.deepEqual(
      inside.panel.webview.options.localResourceRoots?.map(String),
      [
        vscode.Uri.joinPath(extensionUri, 'media'),
        vscode.Uri.joinPath(extensionUri, 'dist', 'media'),
        workspace,
        workspace,
      ].map(String),
    );
    assert.equal(inside.panel.webview.options.enableScripts, true);

    const away = await openPreview(vscode.Uri.file(outside));
    assert.deepEqual(
      away.panel.webview.options.localResourceRoots?.map(String),
      [
        vscode.Uri.joinPath(extensionUri, 'media'),
        vscode.Uri.joinPath(extensionUri, 'dist', 'media'),
        vscode.Uri.file(tempDir),
        workspace,
      ].map(String),
    );
  });

  it('keeps the document URI of a file with "&" in its name inside the attribute', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-shell-'));
    tempDirs.push(tempDir);
    const file = path.join(tempDir, "a&b'c d.md");
    fs.writeFileSync(file, '# Odd name\n');

    const preview = await openPreview(vscode.Uri.file(file));
    const body = /<body\b[^>]*>/.exec(preview.panel.webview.html)?.[0];
    assert.ok(body, 'the shell has a <body> tag');
    const attr = /\sdata-uri="([^"]*)"/.exec(body)?.[1];
    assert.ok(attr !== undefined, 'data-uri is a double-quoted attribute');
    // `Uri.toString()` percent-encodes the characters that need escaping, so the raw ones never reach the attribute.
    assert.ok(attr.includes('a%26b'), attr);
    assert.ok(!/[&"<]/.test(attr), `unescaped character in ${attr}`);
    assert.equal(attr, preview.uri.toString());
  });

  it('escapes &, " and < in the document URI attribute (escapeAttr)', async () => {
    const preview = await openPreview(vscode.Uri.joinPath(workspaceFolder(), 'other.md'));
    // A URI whose string form has characters `Uri.toString()` itself would have encoded, to exercise escapeAttr.
    const odd = { toString: () => 'file:///x&y"z<w' } as unknown as vscode.Uri;
    const html = getWebviewHtml(preview.panel.webview, extensionUri, odd, true);
    const body = /<body\b[^>]*>/.exec(html)?.[0];
    assert.ok(body);
    assert.ok(body.includes('data-uri="file:///x&amp;y&quot;z&lt;w"'), body);
    // Exactly the two attributes of the shell, so the value did not break out of its quotes.
    assert.deepEqual([...body.matchAll(/\s([a-z-]+)="/g)].map((m) => m[1]), ['data-uri', 'data-mermaid-src']);
  });
});
