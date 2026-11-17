# Security

Markdown files can come from anywhere: a cloned repository, a pull request, an AI agent. Read Markdown treats every document as untrusted. This page describes what a document can and cannot do in the preview.

## Scripts

A document cannot run scripts. The preview has two independent layers:

1. **Content Security Policy.** The webview runs only the extension's own script, identified by a nonce generated for each page. Inline scripts, event handler attributes and `javascript:` URLs never run.
2. **Sanitizer.** Before any rendered HTML enters the page, an allowlist sanitizer (DOMPurify) drops every tag, attribute and URL scheme it does not know. `script`, `iframe`, `object`, `embed`, `form`, `meta`, `link` and `base` are removed with their content, and the only form control kept is a task-list checkbox.

## What the policy allows

| Resource | Allowed from |
| --- | --- |
| Scripts | The extension's own script only |
| Stylesheets | The extension, plus inline `<style>` and `style` attributes. Never a remote origin |
| Fonts | The extension and `data:` URLs. Never a remote origin |
| Images, media | The workspace, the document's folder, `data:` (and `blob:` for images); `https:` when `readMarkdown.security.allowRemoteContent` is on |
| Network requests, frames, plugins, form submission | Nothing |

Documents may restyle themselves with `<style>` blocks on purpose; that is a feature, not a gap.

## Remote images and your IP address

Loading a remote image tells its server that someone opened the document, and from which IP address. Tracking pixels in Markdown rely on this.

`readMarkdown.security.allowRemoteContent` is on by default, so remote `https:` images and media load as they do on GitHub. Turn it off to show only images from your workspace, the document's folder and `data:` URLs; this also covers images requested from a document's CSS (`background-image` and similar). The change applies to open previews right away.

Remote stylesheets and fonts are always blocked, whatever this setting says.

## Links

Clicking a link never runs anything:

- `http:`, `https:` and `mailto:` links open in your default browser or mail app.
- Other schemes (`command:`, `vscode:`, `file:`, `javascript:` …) are not opened.
- Local links open inside VS Code. A link to a file **outside** your workspace folders and the document's folder asks for confirmation first. The confirmation comes before the file is even looked up, so a link to a network path (`\\server\share`) does not contact that server unless you agree.
- `#heading` links scroll the preview.

Images follow the same roots: an image outside the workspace folders and the document's folder does not load.

## Raw HTML in a document

Markdown allows raw HTML. It is sanitized like everything else, and the attributes the renderer uses internally (`data-line`, `data-line-end`, `data-task`, `data-vscode-context`, `data-rm-*` and others) are removed from it first. A document therefore cannot pretend that a piece of HTML is a block that can be edited, a task that can be toggled or a menu entry. Raw HTML blocks cannot be edited in the preview.

## Untrusted workspaces

In a workspace you have not trusted (VS Code's Restricted Mode), the extension runs with limits. Workspace settings cannot change:

- `readMarkdown.customCss.inline`, `readMarkdown.customCss.files`
- `readMarkdown.edit.enabled`, `readMarkdown.edit.saveOnCommit`
- `readMarkdown.security.allowRemoteContent`

Your user settings still apply. So a repository you just cloned cannot turn on remote content, load its own CSS into your preview, or make the preview write to files.

## Editing safety

Edits from the preview are checked against the document version they were made from. If the file changed in the meantime (you typed in the source, or an agent rewrote it), the edit is refused instead of overwriting the newer text. Edits go through VS Code's undo stack, and read-only documents (such as a file from git history) cannot be edited.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's [private vulnerability reporting](https://github.com/huntertran/read-markdown/security/advisories/new) for this repository.
