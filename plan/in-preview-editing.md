# In-preview editing of Markdown — feasibility + plan

## Context
User asks: can user edit the Markdown file directly inside the Read Markdown preview webview?
Verdict: **feasible, moderate effort, if editing is block-level raw-source** (click block → textarea with its Markdown source → commit writes back via `WorkspaceEdit`). **True WYSIWYG (contenteditable on rendered HTML → serialize back to Markdown) is not worth it**: HTML→MD round-trip is lossy (list markers, emphasis style `*` vs `_`, tables alignment, raw HTML, footnotes, alerts, front matter, hljs spans, mermaid SVG), would reformat untouched text, and fights sanitize/sections/mermaid DOM rewrites.

### Why block-level is cheap here
- Source map already exists: `rm_source_map` core rule in [src/render/markdown.ts](../src/render/markdown.ts#L52-L62) stamps `data-line` from `token.map[0]`. `token.map[1]` (end line, exclusive) is right there — just not emitted.
- Render message already carries `docVersion` ([src/protocol.ts:56](../src/protocol.ts#L56)) → optimistic-concurrency check free.
- `PreviewPanel` holds the `vscode.TextDocument` for both `panel` and `editor` kinds ([src/preview/previewPanel.ts:31](../src/preview/previewPanel.ts#L31)); `workspace.applyEdit` works on both, gives undo/redo, dirty state, save, and existing text-change → debounced re-render path updates preview automatically.
- Custom editor kind (`readMarkdown.editor`) is a `CustomTextEditorProvider` → edits to the TextDocument are the documented pattern.

### Hard parts / risks
1. **Re-render clobbers editor**: `renderContent` does `content.replaceChildren(...)` ([webview/main.ts:72](../webview/main.ts#L72)). Must defer incoming `render` while a block editor is open (queue latest, apply on close).
2. **Nested blocks**: list items / blockquotes / tables nest `data-line` elements. Choose editable unit = top-level block (`token.level === 0`) to keep ranges disjoint and simple. Lists/tables edit as a whole.
3. **Stale ranges**: file changed (typing in source editor, agent rewrite via file watcher) while editing → host rejects if `document.version !== docVersion`; webview shows "file changed, reopen block" and keeps user text.
4. **Front matter**: blanked before render; give `<details class="rm-frontmatter">` its own range (lines 0..fmLineCount).
5. **Scroll/echo guards**: commit triggers re-render + possibly editor scroll; keep `scrollProgrammatically`/`ignorePreviewScrollUntil` semantics; anchor-line logic in `webview/scroll.ts` should keep position.
6. **Click conflicts**: links, copy button, task checkboxes, section collapse toggles. Use explicit trigger (double-click or hover ✎ button / `e` key on focused block) not single click.
7. **Line endings / trailing blank line**: replace `Range(start,0,end,0)`; preserve doc EOL (`document.eol`), ensure replacement ends with newline.
8. **Untitled / readonly schemes** (git diff, `vscode-vfs` readonly): disable when `fs.isWritableFileSystem(scheme) === false`.
9. **Security**: textarea value only, never injected as HTML; host validates line range bounds. CSP unchanged.

Effort estimate: ~1–2 days incl. tests. Nothing architectural blocks it.

## Recommended implementation (block-level source edit, opt-in setting)

### Protocol — [src/protocol.ts](../src/protocol.ts)
- `UiConfig.editable: boolean`.
- `FromWebview`: `{ type: 'editBlock'; start: number; end: number; docVersion: number; text: string }`, `{ type: 'requestBlockSource'; start: number; end: number }`.
- `ToWebview`: `{ type: 'blockSource'; start; end; text; docVersion }`, `{ type: 'editResult'; ok: boolean; reason?: 'stale' | 'readonly' | 'failed' }`.

### Renderer — [src/render/markdown.ts](../src/render/markdown.ts)
- In `rm_source_map`, for `token.level === 0` openers/leaves also set `data-line-end = token.map[1]`. Fence/code_block custom rules must emit it too (they rebuild markup manually), plus mermaid div and front-matter prefix.
- Unit tests in `test/unit/renderer.test.ts` for end lines (paragraph, list, fence, table, front matter).

### Host — [src/preview/previewPanel.ts](../src/preview/previewPanel.ts)
- `requestBlockSource` → reply with `document.getText(new Range(start,0,end,0))` + `document.version` (fetch from host, not from cached render, so text is exact incl. CRLF).
- `editBlock` → validate ints & bounds, version match, writable scheme → `WorkspaceEdit.replace(uri, Range(start,0,end,0), normalizeEol(text))` → `applyEdit`; post `editResult`. Re-render comes via existing change listener in `PreviewManager`.
- Optional setting `readMarkdown.edit.saveOnCommit` (default false) → `document.save()`.

### Settings — [src/config/settings.ts](../src/config/settings.ts), `package.json`, README
- `readMarkdown.edit.enabled` (default `false`), add to `Settings`, `toUiConfig`, optionally `QUICK_SETTING_KEYS` + `validateQuickSetting`. README settings table.

### Webview — new `webview/editBlock.ts`, wired in [webview/main.ts](../webview/main.ts)
- When `ui.editable`: delegate `dblclick` (and ✎ hover button on `[data-line-end]`) → post `requestBlockSource` → on `blockSource` replace block element with `<textarea class="rm-edit">` auto-sized, Ctrl/Cmd+Enter = commit, Esc = cancel, blur = commit (configurable).
- While open: `renderContent` stores message in `pendingRender` instead of applying; flush on close / `editResult`.
- On `editResult{ok:false,'stale'}`: keep textarea, show inline notice + "reload source" button.
- Styles in [media/preview.css](../media/preview.css) using `--rm-*` vars; new public hook `.rm-edit` (document in README).

## Verification
- `npm run check-types`, `npm run build`.
- Unit: `npm run pretest && npx mocha out/test/unit/renderer.test.js --grep "end line"`.
- Integration test (`test/integration`): open fixture, simulate `editBlock` message via panel, assert `document.getText()` changed and undo restores it; stale version rejected.
- Manual F5 on `test/fixtures/long-ai-doc.md`: edit paragraph, list, fenced code, table, front matter; Ctrl+Z in source editor reverts; edit source editor while block open → stale notice; scroll position stable after commit; mermaid block re-renders.
