# FAQ

## Opening the preview

### How do I make `Ctrl+Shift+V` open Read Markdown?

Set `readMarkdown.preview.replaceDefault` to `true`. `Ctrl+Shift+V` and `Ctrl+K V` (`Cmd` on macOS) then open Read Markdown instead of the built-in preview.

### Can `.md` files open straight in the preview, without the text editor?

Yes. Use **Reopen Editor With… → Read Markdown Preview** once, or add this to your settings:

```json
"workbench.editorAssociations": { "*.md": "readMarkdown.editor" }
```

To open a preview beside every Markdown file you open instead, set `readMarkdown.preview.autoOpen` to `"beside"`.

### Why is the built-in preview button still in the title bar?

VS Code does not let an extension hide another extension's buttons. The book icon next to it is Read Markdown's.

## Search and scroll

### Why doesn't typing in the editor's Find widget highlight anything in the preview?

VS Code does not tell extensions what is typed in the Find widget. Read Markdown follows the **editor selection** instead. Press `Enter` or `F3` in the Find widget: each match is selected, and the preview highlights it.

Selections shorter than `readMarkdown.search.minLength` (2 characters by default) are ignored. Matching ignores case unless `readMarkdown.search.caseSensitive` is on.

### How do I search inside the preview itself?

Press `Ctrl+F` (`Cmd+F`) with the preview focused. Matches inside folded sections are found too, and their sections open.

### Scroll sync moves the editor when I don't want it to.

Turn off `readMarkdown.preview.scrollSync`.

## Outline

### Some headings are missing from the outline.

The outline shows headings down to `readMarkdown.nav.maxDepth`, which is 3 (H1–H3) by default. Raise it to 6 to see every level. It is also in the ⚙ panel as **Navigation depth**.

### Can I start with sections folded?

Set `readMarkdown.sections.startCollapsedBelowLevel`. For example `3` starts with every H3–H6 section folded.

## Changes against git

### I don't see any change marks.

The preview compares the file with its **staged** version (the git index), the same version the editor's gutter bars use. There are no marks when:

- the file has no unstaged changes (staging clears the marks),
- the file is untracked, ignored or outside a git repository,
- VS Code's built-in Git extension is disabled,
- `readMarkdown.changes.mode` is `"off"`.

### Clicking a file in Source Control opens a text diff, not the preview.

VS Code's hooks for showing a diff in a custom editor are not available to published extensions yet. Open the file from the Explorer, or with **Read Markdown: Open Preview**, to see the changes in the preview.

### The inline marks are too busy.

The ± button in the preview toolbar switches that preview to change bars only. `readMarkdown.changes.mode: "gutter"` makes that the default.

### Is removed text searchable?

No. Removed text is shown for reference only: search highlighting, the outline and block editing skip it.

## Editing in the preview

### I don't see ✎ or Edit Block.

- Turn on `readMarkdown.edit.enabled` (**Edit blocks in preview** in the ⚙ panel).
- In an untrusted workspace, a workspace setting cannot turn editing on; your user setting can.
- Raw HTML blocks and read-only documents (such as a file from git history) cannot be edited.

### Saving a block was refused.

The file changed while the block was open: you typed in the source editor, or an agent rewrote the file. Copy your text, cancel to reload the block, and apply your change again. Nothing is overwritten silently.

### My edit didn't save the file.

Edits go into the open document, like typing in the editor, and wait for you to save. Turn on `readMarkdown.edit.saveOnCommit` to save after each edit. A file that is not open in any text editor is always saved, so an edit never sits in an unsaved buffer you cannot see.

### Can I reorder list items in a blockquote?

No. Items move within their own list only, and lists inside blockquotes cannot be reordered.

## Images, fonts and styles

### An image does not show.

- Relative paths are resolved from the document's folder.
- Images outside your workspace folders and the document's folder are not loaded.
- Remote `https:` images need `readMarkdown.security.allowRemoteContent` (on by default). `http:` images never load.

### A font or `@import` in my custom CSS has no effect.

The preview never loads remote stylesheets or fonts. Use a font installed on your system, a `data:` URL, or a file in the workspace. See [Custom CSS](Custom-CSS) and [Security](Security).

### My custom CSS file isn't applied.

Relative paths in `readMarkdown.customCss.files` start from the **first** workspace folder. In an untrusted workspace, custom CSS from workspace settings is ignored.

### Mermaid diagrams show as code.

Check that `readMarkdown.mermaid.enabled` is on and the code block's language is `mermaid`. A diagram with a syntax error shows Mermaid's error message instead.

## Agents

### How do I follow an agent working through a plan?

See [Agent Workflows](Agent-Workflows).

### `[/]` shows as plain text.

`readMarkdown.tasks.agentProgress` is off. Turn it on, or switch on **Show agent progress on task lists** in the ⚙ panel.
