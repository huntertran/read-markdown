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
```

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
- `sync/selection.ts` (pure): selection text → search term (strips Markdown wrappers/line prefixes), plus `blockStartFor`/`countOccurrences` so the webview can highlight the *specific* occurrence, identified by block line + occurrence index.

### Webview side
`webview/main.ts` wires modules: `sanitize` (strips scripts/handlers — defence in depth on top of nonce CSP), `sections` (wraps headings into collapsible `<section class="rm-section">`), `nav` (outline + filter + active heading), `scroll` (data-line ↔ scrollY map, anchor line kept across reflow), `search`, `codeblocks` (copy button posts `copy` to host), `mermaid` (lazy-loads `dist/media/mermaid.min.js`, caches SVGs, re-renders on scheme change), `settingsPanel` (quick ⚙ panel posting `updateSetting`). `api.ts` wraps `acquireVsCodeApi` and `get/patchState` (scroll line + collapsed slugs persist across re-renders and reloads).

### Feedback-loop guards
Scroll sync is bidirectional; echo suppression uses timestamps (`SCROLL_ECHO_MS` in manager, `ignorePreviewScrollUntil` on panel, `isSuppressed()`/`scrollProgrammatically` in `webview/scroll.ts`). Keep these when touching scroll code. Highlight messages are deduped via `lastHighlightKey`.

## Conventions
- New settings: add to `package.json` `contributes.configuration`, `Settings`/`getSettings`, and if the webview needs it `UiConfig`/`toUiConfig`; quick-panel-editable ones also go in `QUICK_SETTING_KEYS` + `validateQuickSetting`. Update README settings table.
- Custom CSS hooks are public API (documented in README): `.rm-markdown`, `#rm-nav`, `.rm-section`, `.rm-heading`, `pre.rm-code`, `--rm-*` variables — don't rename casually.
- Keep `render/`, `config/styles.ts`, `sync/selection.ts` free of `vscode` imports so unit tests (`test/unit`) run under plain mocha.
