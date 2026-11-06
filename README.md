# Read Markdown

A reading-focused Markdown preview for VS Code, built for the long documents AI coding agents generate
(plans, specs, reports).

## Features

- **Quick navigation**: a sidebar outline of the document's headings. It has a filter box, highlights the section you are reading, and has buttons to collapse or expand everything. Drag its edge to resize it; the width is saved to `readMarkdown.nav.width` (double-click the edge to reset).
- **Collapsible sections**: fold the content under any heading with the chevron next to it. Folded sections are remembered while you edit.
- **Search highlight sync**: select text in the Markdown source, or step through matches with the Find widget (`Ctrl+F`, then `Enter`/`F3`). Every occurrence is highlighted in the preview, and it scrolls to the current match.
- **Scroll sync** between the source and the preview, in both directions.
- **Typography and colors**: theme presets (follow VS Code, light, dark, sepia, high contrast), body font, size, line height, content width, background and text colors, plus heading font, size, color and highlight style.
- **Custom CSS**, inline in settings or from files. Files are watched and reloaded live.
- **Quick settings panel** (⚙ in the preview) for the most common options. It writes your VS Code settings.
- **Code highlighting** with a copy button, **Mermaid diagrams**, GitHub alerts (`> [!NOTE]`), task lists, footnotes, front matter.
- **Live refresh**: the preview updates as you type, and also when the file changes on disk (e.g. an agent rewrites it).

## Usage

| Action | How |
| --- | --- |
| Open preview | `Read Markdown: Open Preview` / book icon in the editor title |
| Open to the side | `Read Markdown: Open Preview to the Side` |
| Jump to source | Double-click a heading, or `Read Markdown: Show Source` |
| Toggle outline | ☰ in the preview, or `Read Markdown: Toggle Quick Navigation` |

### Replacing the built-in preview

- `readMarkdown.preview.replaceDefault: true` makes `Ctrl+Shift+V` / `Ctrl+K V` open Read Markdown instead of the built-in preview.
- `readMarkdown.preview.autoOpen: "beside"` opens the preview automatically next to every Markdown file you open (`"active"` opens it in the same group).
- To open `.md` files *directly* in the preview, use **Reopen Editor With… → Read Markdown Preview**, or add:

  ```json
  "workbench.editorAssociations": { "*.md": "readMarkdown.editor" }
  ```

VS Code does not let extensions hide the built-in preview button, so it stays in the editor title bar.

### About search sync

VS Code does not expose the Find widget's text to extensions. Read Markdown mirrors the **editor selection** instead. Typing in the Find widget and pressing `Enter`/`F3` selects each match, so the preview follows along. Inside the preview you can also press `Ctrl+F` to use the webview's own find.

## Settings

All settings live under `readMarkdown.*`. Search "Read Markdown" in the Settings UI. Highlights:

| Setting | Default | Description |
| --- | --- | --- |
| `nav.show` / `nav.position` / `nav.maxDepth` / `nav.width` | `true` / `left` / `3` / `260` | Quick navigation |
| `theme.preset` | `vscode` | `vscode`, `light`, `dark`, `sepia`, `high-contrast` |
| `body.fontFamily`, `body.fontSize`, `body.lineHeight`, `body.maxWidth` | system, 15, 1.65, 860 | Body text |
| `body.backgroundColor`, `body.textColor` | preset | Colors |
| `headings.fontFamily`, `headings.scale`, `headings.fontSizes`, `headings.colors` | | Headings |
| `headings.highlight`, `headings.highlightColor` | `underline` | `none`, `underline`, `background`, `leftBorder` |
| `customCss.inline`, `customCss.files` | | Extra CSS |
| `search.syncSelection`, `search.caseSensitive`, `search.minLength` | `true`, `false`, `2` | Highlight sync |
| `search.highlightColor`, `search.currentHighlightColor` | theme | Match colors |
| `table.headerBackgroundColor`, `table.headerTextColor` | accent tint, body text | Table header colors |
| `sections.collapsible`, `sections.startCollapsedBelowLevel` | `true`, `0` | Folding |
| `code.copyButton`, `mermaid.enabled`, `preview.scrollSync` | `true` | Extras |

Example:

```json
"readMarkdown.theme.preset": "sepia",
"readMarkdown.body.fontFamily": "Georgia, serif",
"readMarkdown.headings.colors": { "h1": "#8b4513", "h2": "#a0522d" },
"readMarkdown.customCss.inline": ".rm-markdown p { text-align: justify; }"
```

Custom CSS can target `.rm-markdown` (content), `#rm-nav` (outline), `.rm-section`, `.rm-heading`, `pre.rm-code` and the `--rm-*` CSS variables.

## Development

```bash
npm install
npm run build        # bundle extension + webview into dist/
npm run watch        # rebuild on change
npm run check-types
npm test             # unit tests (mocha) + integration tests (VS Code test host)
npm run package      # build a .vsix
```

Press `F5` to launch an Extension Development Host with `test/fixtures` open.

### Layout

- `src/extension.ts`: activation and commands
- `src/preview/`: webview panels, manager (sync, links, auto-open), HTML shell
- `src/render/`: markdown-it renderer (source map, headings, highlight.js, Mermaid, alerts)
- `src/config/`: settings, CSS variable generation, custom CSS loader
- `src/sync/selection.ts`: selection to search term logic
- `webview/`: preview UI (outline, sections, search highlight, scroll sync, settings panel)
- `media/preview.css`: preview styles

## License

GPL-3.0

The collapse-all / expand-all and alert icons are from [Codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0).
