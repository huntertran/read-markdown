# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

VS Code extension ("Read Markdown", id `huntertran.read-markdown`): a reading-focused Markdown preview webview with heading outline, collapsible sections, selection→search highlight sync, two-way scroll sync, typography settings, Mermaid and highlight.js.

## Commands

```bash
npm run build          # esbuild: dist/extension.js + dist/media/main.js, copies mermaid.min.js to dist/media
npm run watch          # rebuild on change
npm run check-types    # tsc for BOTH projects: root tsconfig (src, test) and webview/tsconfig.json
npm test               # pretest builds + bundles tests into out/, then unit (mocha) + integration (VS Code host)
npm run test:unit      # mocha on out/test/unit — requires `npm run pretest` first (tests are not run from TS)
npm run test:integration
npm run package        # vsce package -> .vsix
npm run demo:gifs      # re-record docs/images/*.gif (scripts/demo/record.mjs; one scene: `node scripts/demo/record.mjs edit`)
```

`scripts/demo/record.mjs` starts the `.vscode-test` VS Code with `--remote-debugging-port` and attaches with `playwright-core` (`_electron.launch` fails: release builds block `--inspect`). It strips `ELECTRON_RUN_AS_NODE` from env (set inside VS Code terminals). Frames come from the CDP screencast, the cursor is a drawn overlay, and ffmpeg encodes the GIF. Scenes use real selectors, so update them when renaming webview classes.

Single test: tests run from bundled JS, so rebuild first (`npm run pretest`), then
- unit: `npx mocha out/test/unit/renderer.test.js --grep "source lines"`
- integration: `npx vscode-test --grep "<pattern>"` (opens `test/fixtures` as workspace, see `.vscode-test.mjs`)

Esbuild does no type checking — always run `npm run check-types`. `F5` launches an Extension Development Host on `test/fixtures` (good long sample: `test/fixtures/long-ai-doc.md`).

## Architecture

Two separate bundles that only talk via `postMessage`:

- **Extension host** (`src/`, Node, CJS, `vscode` external) — renders Markdown to HTML.
- **Webview** (`webview/`, browser IIFE, own tsconfig with DOM lib, no `vscode`/Node imports) — DOM work only.

`src/protocol.ts` is the shared contract (`ToWebview`, `FromWebview`, `UiConfig`, `QUICK_SETTING_KEYS`, `WebviewState`). It is included in both tsconfigs and must stay free of runtime imports. Adding a message or UI option means editing protocol + both sides.

### Extension side
- `extension.ts` registers commands, a `WebviewPanelSerializer` (restore after reload, keyed by `WebviewState.uri`), and a custom text editor `readMarkdown.editor`. Both panel kinds become a `PreviewPanel` (`kind: 'panel' | 'editor'`).
- `PreviewManager` is the singleton hub: panel registry by document URI, one shared markdown-it renderer, settings cache, `CustomCssProvider`, and all VS Code event listeners (text change → debounced render, selection → highlight, visible ranges → scroll, config change → broadcast config, auto-open). Also resolves link clicks (external schemes only http/https/mailto; other schemes deliberately ignored; `.md` links open in a preview).
- `PreviewPanel` owns one webview: CSP'd HTML shell from `preview/html.ts`, `localResourceRoots`, a file watcher for on-disk changes (agents rewriting the file), 250 ms render debounce. Nothing is posted until the webview sends `ready`; on `ready` it sends `config` then `render`, then initial scroll/highlight.
- `render/markdown.ts` — markdown-it (`html: true`) + footnote + task lists. A core rule stamps `data-line` (0-based source line) on every block-opening token and collects `blockLines`; this source map drives scroll sync and search occurrence targeting. Also: heading slugs (`render/headings.ts`, GitHub-style dedupe `-1`), front matter, GitHub alerts, highlight.js, Mermaid placeholders, and `resolveResource` rewriting relative image paths to webview URIs. Pure (no `vscode`) → unit-testable.
- `config/settings.ts` reads `readMarkdown.*` into `Settings`; `toUiConfig` projects the subset the webview needs. `validateQuickSetting` whitelists/validates every value coming from the webview quick panel before `updateSetting` writes it (to the most specific scope already defining it; `''` removes the key).
- `config/styles.ts` (pure) turns settings + theme presets into a `--rm-*` CSS-variable block consumed by `media/preview.css`. `config/customCss.ts` loads/watches user CSS files.
- `edit/` — in-preview block editing (opt-in `readMarkdown.edit.enabled`). Top-level blocks carry `data-line-end` (exclusive, from `token.map[1]`; front matter too). `blockText.ts` (pure) converts between the source range and the textarea text (EOL, trailing blank lines kept verbatim); `blockEdit.ts` does the version-checked `WorkspaceEdit`. `PreviewPanel` handles `requestBlockSource`/`editBlock`, renders immediately after an edit, and saves if `edit.saveOnCommit` or no tab shows the document.
- Track changes vs git index (`readMarkdown.changes.mode`: `inline`/`gutter`/`off`). VS Code's SCM-diff hooks for custom editors (`customEditorDiffs`, `textEditorDiffInformation`, `documentDiff`) are proposed API, so: `scm/gitBaseline.ts` reads the index version through the `vscode.git` extension API (`repo.show('', fsPath)`; non-blocking: returns undefined until the API is initialized, then fires `onDidChange`; per-URI cache refreshed on `repo.state.onDidChange`, fires only when the content changed). `PreviewPanel.render` renders that original with the same renderer (cached) and sends `render.changes = { originalHtml, ops }`; `ops` = `diffDocument` over `RenderResult.topBlocks` (source text of each `data-line-end` block). `diff/` is pure and shared with the webview (in `webview/tsconfig.json` include): `textDiff.ts` (LCS `diffSequences`, `tokenize`/`tokenizeLines`, `diffTokens`, `similarity`, `tokenBag`/`bagSimilarity`), `blockDiff.ts` (`alignBlocks`: common prefix/suffix, then similarity-weighted alignment so one unchanged block can't strand edited ones, then same-kind modify pairs, then move detection among leftovers). SCM-tab clicks are deliberately left to VS Code's text diff (tab replacement was tried and dropped).
- `sync/selection.ts` (pure): selection text → search term (strips Markdown wrappers/line prefixes), plus `blockStartFor`/`countOccurrences` so the webview can highlight the *specific* occurrence, identified by block line + occurrence index.

### Webview side
`webview/main.ts` wires modules: `sanitize` (strips scripts/handlers — defence in depth on top of nonce CSP), `sections` (wraps headings into collapsible `<section class="rm-section">`), `nav` (outline + filter + active heading), `scroll` (data-line ↔ scrollY map, anchor line kept across reflow), `search`, `codeblocks` (copy button posts `copy` to host), `mermaid` (lazy-loads `dist/media/mermaid.min.js`, caches SVGs, re-renders on scheme change), `settingsPanel` (quick ⚙ panel posting `updateSetting`), `blockActions` (one floating hover rail per `[data-line-end]` block, edit mode only: `⋮⋮` handle opening a menu of `placement: 'menu'` actions, then `placement: 'rail'` buttons; ends left of a heading's `.rm-fold`. Features call `registerBlockAction` instead of adding their own gutter buttons — the handle is the intended drag grip), `editBlock` (registers the ✎ rail action, or double-click if `edit.doubleClick`, swaps a `[data-line-end]` block for a textarea; `deferRender` holds back `render` messages while it is open so they don't wipe it; task checkboxes are enabled and post `toggleTask`, which rewrites only the `[ ]`/`[x]` state char via `taskMarkerColumn`). Context menu: `main.ts` stamps `data-vscode-context` (`webviewSection: 'rm-block'`, `rmLine`) on each top-level block and `rmEditable` on `<body>`; `package.json` `webview/context` items run `readMarkdown.editBlock` (→ `startEdit` message) / `readMarkdown.showSource` with that object (`BlockMenuContext` in protocol). `sanitize` strips author-supplied `data-vscode-context`. `listDrag` (edit mode: floating ⠿ grip in a list's left padding; pointer drag lifts the `li` and translates siblings, or a drop line under `prefers-reduced-motion`; Alt+↑/↓ on the grip; reorders the DOM optimistically, then posts `moveListItem` with sibling `starts` + last `data-item-end`, and puts items back on a failed `moveResult`. List items carry `data-item-end` from the renderer; `edit/listMove.ts` (pure) moves the lines, keeping blank-line separators by position and renumbering ordered lists. `blockActions` ends a list's rail left of the grip via `itemGripLeft`). `changes` (runs after `sanitize`, before `buildSections`: tags added/modified/moved blocks `.rm-chg-*`, inline mode clones removed/moved-from blocks in from `originalHtml` with `data-line*`/`id` stripped, re-aligns list items / quoted blocks / table rows with `alignBlocks`, and wraps word diffs in `ins.rm-ins`/`del.rm-del` over text nodes; gutter mode only tags, plus `data-rm-del-before/after`). `changeGutter` (bar overlay in `#rm-main`, ResizeObserver-driven; move jump buttons, hover pairing via `data-move-id`, and an SVG connector per move pair in the left gutter, lanes assigned so overlapping moves don't share one; overview ruler = an SVG data URL set as the page's `::-webkit-scrollbar-track` background via `<style id="rm-change-ruler">` — fixed elements can't cover the native scrollbar, `html::` doesn't match it, so inner scrollbars are reset with `body *::-webkit-scrollbar-track`; relies on VS Code styling `::-webkit-scrollbar` in webviews; VS Code also sets standard `scrollbar-color` on `html`, which disables all `::-webkit-scrollbar*` rules, so the ruler style sets `html { scrollbar-color: auto }` and gives `body` VS Code's value back for inner scrollbars). `REMOVED_SELECTOR` clones are skipped by `sections`, `search`, `codeblocks`, task checkboxes and `listDrag` (not counted as items; hidden via `.rm-list-reordering` during a drag; a failed move restores the full child order). Toolbar ± / `readMarkdown.toggleChanges` flips inline↔gutter per panel (`WebviewState.changesMode`, reset when the setting changes). `api.ts` wraps `acquireVsCodeApi` and `get/patchState` (scroll line + collapsed slugs persist across re-renders and reloads).

### Feedback-loop guards
Scroll sync is bidirectional; echo suppression uses timestamps (`SCROLL_ECHO_MS` in manager, `ignorePreviewScrollUntil` on panel, `isSuppressed()`/`scrollProgrammatically` in `webview/scroll.ts`). Keep these when touching scroll code. Highlight messages are deduped via `lastHighlightKey`.

## Conventions
- New settings: add to `package.json` `contributes.configuration`, `Settings`/`getSettings`, and if the webview needs it `UiConfig`/`toUiConfig`; quick-panel-editable ones also go in `QUICK_SETTING_KEYS` + `validateQuickSetting`. Update README settings table.
- Custom CSS hooks are public API (documented in README): `.rm-markdown`, `#rm-nav`, `.rm-section`, `.rm-heading`, `pre.rm-code`, `--rm-*` variables — don't rename casually.
- Keep `render/`, `diff/`, `config/styles.ts`, `sync/selection.ts` free of `vscode` imports so unit tests (`test/unit`) run under plain mocha.
