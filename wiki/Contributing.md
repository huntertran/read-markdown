# Contributing

Bug reports, ideas and pull requests are welcome in the [repository](https://github.com/huntertran/read-markdown).

## Setup

You need Node.js 22 or later and VS Code.

```bash
git clone https://github.com/huntertran/read-markdown.git
cd read-markdown
npm install
npm run build
```

Press `F5` in VS Code to launch an Extension Development Host with `test/fixtures` open. `test/fixtures/long-ai-doc.md` is a good long sample.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Bundle the extension and the webview into `dist/` |
| `npm run watch` | Rebuild on change |
| `npm run check-types` | Type-check every project (esbuild does no type checking, so always run this) |
| `npm run lint` | ESLint, type-aware; floating promises are errors |
| `npm test` | Build, then unit tests (mocha) and integration tests (a real VS Code) |
| `npm run package` | Build a `.vsix` |
| `npm run demo:gifs` | Re-record the README GIFs (needs ffmpeg; drives a real VS Code window) |
| `npm run wiki:settings` | Regenerate [Settings](Settings) from `package.json` |

### Running one test

Tests run from bundled JavaScript, so build them first with `npm run pretest`. Then:

```bash
npx mocha out/test/unit/renderer.test.js --grep "source lines"   # one unit test
npx vscode-test --grep "<pattern>"                                # one integration test
```

## How it fits together

The extension is two bundles that only talk through `postMessage`:

- **Extension host** (`src/`, Node): renders Markdown to HTML with markdown-it, watches documents and settings, applies edits, reads the git index for track changes.
- **Webview** (`webview/`, browser): everything on screen. Outline, sections, search highlight, scroll sync, the settings panel, block editing, diagrams.

`src/protocol.ts` is the contract between them. Adding a message or a UI option means changing the protocol and both sides.

| Path | Contents |
| --- | --- |
| `src/extension.ts` | Activation, commands, the custom editor |
| `src/preview/` | Webview panels, the manager (sync, links, auto-open), the HTML shell and its Content Security Policy |
| `src/render/` | The markdown-it renderer: source line map, heading slugs, highlight.js, Mermaid, alerts |
| `src/config/` | Settings, CSS variables, the custom CSS loader |
| `src/edit/` | In-preview editing |
| `src/scm/`, `src/diff/` | Track changes against git |
| `webview/` | The preview UI |
| `media/preview.css` | Preview styles |

Code under `src/render/`, `src/diff/` and `src/config/styles.ts` has no `vscode` imports so its tests run under plain mocha. Webview modules are tested in Node on a jsdom window (`test/webview/`).

## Conventions

- **New settings**: add the default (and enum list or range) to `src/config/values.ts`, then to `package.json` `contributes.configuration`, `Settings` / `getSettings`, and `UiConfig` / `toUiConfig` if the webview needs it. Settings the ⚙ panel edits also go in `QUICK_SETTING_KEYS` and `validateQuickSetting`. Update the README table and run `npm run wiki:settings`. A unit test fails if `values.ts` and `package.json` drift apart.
- **Custom CSS hooks are public API**: `.rm-markdown`, `#rm-nav`, `.rm-section`, `.rm-heading`, `pre.rm-code` and the `--rm-*` variables. Don't rename them casually ([Custom CSS](Custom-CSS)).
- **Scroll sync works in both directions** and relies on echo suppression on both sides. Keep it when touching scroll code.
- **Webview class names** are used by the GIF recording scenes in `scripts/demo/`. Update the scenes when you rename one.

## Dependencies and the lockfile

CI installs with npm 10 (Node 22). If you change `package-lock.json` with a newer npm, check it with:

```bash
npx npm@10 ci
```

## CI

Every push and pull request runs:

| Job | Checks |
| --- | --- |
| Linux | Types, lint, the generated wiki settings page, tests, packaging (the `.vsix` must contain exactly the expected files), `npm audit` |
| Windows | Types, tests |
| Linux, VS Code 1.90.0 | Tests on the oldest supported VS Code (keep it in step with `engines.vscode`) |

## Editing this wiki

The wiki is generated from the `wiki/` folder of the repository: a workflow publishes it on every push to `main`. Edits made in the wiki's web editor are overwritten, so change the files in `wiki/` through a pull request instead.

- One page per file; the file name is the page title (`Agent-Workflows.md` → "Agent Workflows").
- Link pages without `.md`: `[Settings](Settings)`.
- Images: link the files in `docs/images` by their full `raw.githubusercontent.com` URL.
- [Settings](Settings) is generated: run `npm run wiki:settings` instead of editing it.
