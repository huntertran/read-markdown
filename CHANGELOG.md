# Changelog

## 0.4.0

- Track changes against git: a git-tracked file opened in the preview shows how it differs from its staged
  version, Word style. Removed words are struck through on red, added ones highlighted green, removed blocks
  stay visible in place, and moved paragraphs / list items are double-struck in red where they were and
  double-underlined in green where they are now, joined by a yellow arrow in the margin (hover pairs
  them, ↑/↓ jumps). Code blocks compare line by line, tables cell by cell, change bars sit beside the
  text, and the scrollbar marks where the changes are. The ± toolbar button switches a preview to bars
  only; `readMarkdown.changes.mode` (`inline` / `gutter` / `off`) sets the default. Clicking a file in the
  Source Control view still opens VS Code's text diff.
- Reorder list items in the preview (edit mode): drag the ⠿ grip left of a bullet or checkbox, or press
  `Alt+↑`/`Alt+↓` on it. Siblings slide aside while you drag (a drop line instead when reduced motion is on).
  Nested items move along, numbered lists keep their numbers, and the move is a single undo step.
- Block actions now share one toolbar in the left margin (⠿ menu, then ✎), so the edit button no longer
  covers a heading's collapse arrow. The ⠿ menu adds **Show source** for any block. Edit mode reserves a
  slightly wider left margin to fit it.
- Double-clicking a heading no longer jumps to the source; it selects text like anywhere else (or opens the
  heading for editing when `readMarkdown.edit.doubleClick` is on). Use right-click → **Show Source**,
  ⠿ → **Show source** or `Read Markdown: Show Source` instead.
- The preview's right-click menu has **Edit Block** (edit mode) and **Show Source** for the block under the
  pointer, next to Cut/Copy/Paste.

## 0.3.0

- Edit in the preview (opt-in, `readMarkdown.edit.enabled`): click ✎ next to a block
  to edit its Markdown source in place. `Ctrl+Enter` saves the block, `Esc` cancels. Task list checkboxes
  can be clicked to check or uncheck items in the source directly. Edits are undoable
  and are refused if the file changed in the meantime. Sub-options: `readMarkdown.edit.doubleClick`
  opens a block by double-clicking it, `readMarkdown.edit.saveOnCommit` saves the file after each edit.

## 0.2.0

- Resizable navigation outline: drag its edge to resize it; the width is remembered
  (`readMarkdown.nav.width`). Double-click the edge to reset it.
- Fix: a closed find widget no longer reappears when you switch back to the preview.

## 0.1.0

Initial release.

### Reading
- Reading-focused Markdown preview that refreshes as you type and when the file changes on disk.
- Quick navigation outline (left or right) with a heading filter and active-section tracking.
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
