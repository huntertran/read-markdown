# Custom CSS

Most styling is available as settings ([Settings](Settings)). For anything else, add your own CSS:

- `readMarkdown.customCss.inline`: CSS text in `settings.json`.
- `readMarkdown.customCss.files`: a list of CSS files, absolute or relative to the first workspace folder. They are watched and reloaded as you save them.

Custom CSS comes after all built-in styles, so a rule with the same specificity wins. A document can also carry its own `<style>` block.

The preview never loads remote stylesheets or fonts: `@import url(https://…)` and remote `@font-face` sources have no effect. Use fonts installed on your system, `data:` URLs, or files in the workspace. See [Security](Security).

In an untrusted workspace, custom CSS from workspace settings is ignored; your user settings still apply.

## Stable hooks

These names are public and kept across releases. Other classes in the preview are internal and may change.

| Selector | What it is |
| --- | --- |
| `.rm-markdown` | The document content |
| `#rm-nav` | The outline sidebar |
| `.rm-section` | A heading and everything under it, nested by level |
| `.rm-heading` | A heading inside a section |
| `pre.rm-code` | A code block |
| `.rm-edit` | The in-place block editor |
| `ins.rm-ins` / `del.rm-del` | Changed words (track changes) |
| `.rm-chg-ins`, `.rm-chg-del`, `.rm-chg-mod`, `.rm-chg-move-from`, `.rm-chg-move-to` | Changed blocks |
| `.rm-chg-bar` | Change bars |
| `.task-list-item[data-task='active']` | A step in progress; its `label::after` is the "working" label |
| `.rm-task-just-done` | A step that was just checked |
| `#rm-task-progress` | The progress bar |
| `.rm-nav-tasks` | `done/total` counts in the outline |
| `body[data-scheme='dark']`, `body[data-scheme='light']` | The preview's resolved color scheme |

## Variables

Set by your settings, on `:root`. Override them to change a color everywhere it is used.

| Variable | Setting |
| --- | --- |
| `--rm-bg`, `--rm-fg` | `body.backgroundColor`, `body.textColor` (or the preset) |
| `--rm-muted`, `--rm-accent`, `--rm-border`, `--rm-link` | Preset colors |
| `--rm-code-bg`, `--rm-code-fg` | Code block background, inline code text |
| `--rm-nav-bg`, `--rm-nav-width` | Outline background, `nav.width` |
| `--rm-font`, `--rm-font-size`, `--rm-line-height`, `--rm-max-width` | `body.*` |
| `--rm-heading-font`, `--rm-heading-hl` | `headings.fontFamily`, `headings.highlightColor` |
| `--rm-h1-size` … `--rm-h6-size`, `--rm-h1-color` … `--rm-h6-color` | `headings.scale` / `fontSizes`, `headings.colors` |
| `--rm-search-bg`, `--rm-search-current-bg` | `search.highlightColor`, `search.currentHighlightColor` |
| `--rm-table-header-bg`, `--rm-table-header-fg` | `table.headerBackgroundColor`, `table.headerTextColor` (only set when customized) |

Track changes colors: `--rm-chg-ins-bg`, `--rm-chg-del-bg`, `--rm-chg-del-line`, `--rm-chg-move`, `--rm-chg-move-arrow`, and the bar colors `--rm-chg-added`, `--rm-chg-modified`, `--rm-chg-deleted` (these default to your VS Code theme's gutter colors).

## Recipes

### Justified text with hyphenation

```css
.rm-markdown p { text-align: justify; hyphens: auto; }
```

### A printed-page look

```css
:root {
  --rm-font: Georgia, 'Times New Roman', serif;
  --rm-max-width: 42em;
}
.rm-markdown p { text-indent: 1.5em; margin: 0; }
.rm-markdown h1 + p, .rm-markdown h2 + p, .rm-markdown h3 + p { text-indent: 0; }
```

### Numbered headings

```css
.rm-markdown { counter-reset: h2; }
.rm-markdown h2 { counter-reset: h3; }
.rm-markdown h2::before { counter-increment: h2; content: counter(h2) ". "; }
.rm-markdown h3::before { counter-increment: h3; content: counter(h2) "." counter(h3) " "; }
```

Use `::before`, not `::after`: the preview uses a heading's `::after` to show that a section is folded.

### Compact tables

```css
.rm-markdown table { font-size: 0.9em; }
.rm-markdown th, .rm-markdown td { padding: 2px 8px; }
```

### Softer track changes

```css
:root {
  --rm-chg-ins-bg: color-mix(in srgb, #2ea043 10%, transparent);
  --rm-chg-del-bg: color-mix(in srgb, #f85149 10%, transparent);
}
```

### Different colors in dark mode

```css
body[data-scheme='dark'] .rm-markdown a { color: #79c0ff; }
```

### Wider outline text, no wrapping

```css
#rm-nav { font-size: 13px; white-space: nowrap; }
```

### Hide the "working" label on steps in progress

```css
.task-list-item[data-task='active'] label::after { display: none; }
```

## Finding a selector

Run **Developer: Open Webview Developer Tools** from the Command Palette while the preview is focused, then inspect the element. Anything not in the stable list above may be renamed in a later release.
