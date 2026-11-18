# Keyboard and Mouse

Every shortcut and gesture in the preview, by area.

## Opening the preview

| Action | How |
| --- | --- |
| Open preview | **Read Markdown: Open Preview**, the book icon in the editor title, or right-click a `.md` file in the Explorer |
| Open to the side | **Read Markdown: Open Preview to the Side** |
| Use `Ctrl+Shift+V` / `Ctrl+K V` (`Cmd` on macOS) | Set `readMarkdown.preview.replaceDefault` to `true` |
| Open `.md` files directly in the preview | **Reopen Editor With… → Read Markdown Preview**, or `"workbench.editorAssociations": { "*.md": "readMarkdown.editor" }` |
| Go to a source line in the preview | `Ctrl+G` while the preview is the active editor, or **Read Markdown: Go to Line**. The section holding the line expands and the block flashes. Go to File's `file.md:42` opens a `readMarkdown.editor` preview at the top: VS Code does not pass the line to custom editors |
| Jump from the preview to the source | Right-click a block → **Show Source**, the Show Source icon in the editor title, or **Read Markdown: Show Source** |

## Toolbar

| Button | Action |
| --- | --- |
| ☰ | Show or hide the outline (also **Read Markdown: Toggle Quick Navigation**) |
| ↑ | Back to top |
| ± | Switch this preview between inline changes and change bars only (also **Read Markdown: Toggle Inline Changes**). Shown when the file has changes |
| Follow | Stop or resume following steps in progress. Shown while a step is in progress |
| ⚙ | Quick settings panel. `Esc` closes it; `←` / `→`, `Home`, `End` move between its tabs |

## Outline

| Action | How |
| --- | --- |
| Jump to a heading | Click it |
| Filter headings | Type in the filter box. `Enter` jumps to the first match, `Esc` clears the filter |
| Collapse or expand all sections | The button beside the filter |
| Resize | Drag the outline's edge; double-click it to reset. With the edge focused, `←` / `→` resize in steps |

## Reading

| Action | How |
| --- | --- |
| Fold a section | The chevron beside its heading |
| Find in the preview | `Ctrl+F` / `Cmd+F` in the preview. Matches inside folded sections are found and their sections open |
| Highlight text from the source | Select it in the source editor, or step through matches with the editor's Find widget (`Enter` / `F3`) |
| Copy a code block | The **Copy** button on the block |
| Follow a link | Click. Links to other Markdown files open in a preview; `#heading` links reveal the heading |

## Mermaid diagrams

| Action | How |
| --- | --- |
| Zoom | The hover toolbar (− / +), `Ctrl` / `Cmd` + wheel, or a trackpad pinch. Zooms around the pointer |
| Pan | Drag, once zoomed in (an unzoomed diagram keeps normal text selection) |
| Keyboard (diagram focused) | `+` / `-` zoom, arrow keys pan while zoomed, `0` resets, `F` opens full screen |
| Full screen | ⛶ on the toolbar or `F`. Wheel zooms, drag pans, `0` fits, `Esc` closes |

## Tables

| Action | How |
| --- | --- |
| Resize a column | Drag the right border of any cell in that column |
| Reset the table | Double-click a column border |

Widths are kept per preview, across edits and reloads, and are never written to the Markdown.

## Editing

Needs `readMarkdown.edit.enabled` (**Edit blocks in preview** in the ⚙ panel).

| Action | How |
| --- | --- |
| Edit a block | Hover it and click ✎, right-click → **Edit Block**, or double-click if `readMarkdown.edit.doubleClick` is on |
| More block actions | The block actions handle at the left end of the hover toolbar. In its menu: `↑` / `↓`, `Home` / `End` move, `Esc` closes |
| Save the block | `Ctrl+Enter` (`Cmd+Enter` on macOS) or **Save** |
| Cancel | `Esc` or **Cancel** |
| Tick a task | Click its checkbox (clicking the text does not toggle it). An in-progress step's checkbox marks it done |
| Reorder a list item | Drag the grip left of its bullet or checkbox; `Esc` cancels the drag. With the grip focused, `Alt+↑` / `Alt+↓` moves it by one |
| Undo | `Ctrl+Z` in the source editor: preview edits go through the normal undo stack, and a list move is one step |

## Changes against git

| Action | How |
| --- | --- |
| See both ends of a moved block | Hover either end: both are outlined and the arrow between them is highlighted |
| Jump to the other end | The ↑ / ↓ button beside the move arrow |
