# Changelog

## 0.1.0

Initial release.

### Reading
- Reading-focused Markdown preview that refreshes as you type and when the file changes on disk.
- Quick navigation outline (left or right) with a heading filter and active-section tracking.
  Drag its edge to resize it; the width is remembered.
- Collapsible sections, with one button that collapses all sections or expands them again.
- Code highlighting with a copy button, Mermaid diagrams, task lists, footnotes and front matter.
- GitHub alerts (`NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`), each with a faint type icon in the background.
- Clearer checkboxes in task lists: done items are filled and dimmed.
- Table headers stand out from the body rows.

### Sync
- Selection-based search highlighting: select text or use Find in the source to highlight every
  match in the preview and scroll to the current one.
- Two-way scroll sync between the source and the preview, which stays aligned when the editor
  or preview is resized.

### Customization
- Theme presets: follow VS Code, light, dark, sepia and high contrast.
- Body font, size, line height, content width and colors.
- Heading font, sizes, colors and highlight style.
- Table header background and text colors.
- Custom CSS, inline or from watched files.
- Quick settings panel (⚙) in the preview for the most common options, including table header colors.

### Integration
- Option to replace the built-in preview (`Ctrl+Shift+V` / `Ctrl+K V`).
- Option to open the preview automatically when you open a Markdown file.
- Custom editor, so `.md` files can open directly in the preview.
