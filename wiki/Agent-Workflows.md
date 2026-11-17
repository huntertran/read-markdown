# Agent Workflows

Read Markdown is built for the long documents AI coding agents write: plans, specs, reports. This page covers how to set up an agent so you can follow its work in the preview.

## The task marker convention

Agents usually write a plan as a task list and work through it step by step. Have the agent mark each step it is working on:

| Source | Meaning | Preview |
| --- | --- | --- |
| `- [ ] step` | To do | Empty checkbox |
| `- [/] step` (or `[~]`, `[-]`) | In progress | Highlighted row, dashed checkbox, animated "working" label |
| `- [x] step` | Done | Checked; flashes briefly when it was in progress a moment ago |

When a step turns `[/]`, the preview scrolls to it and expands its section. A progress bar at the top and `done/total` counts in the outline show how far along the plan is. Several steps can be `[/]` at once for parallel work.

GitHub and other renderers show `[/]` as plain text, so the plan stays readable everywhere.

## Instructions to give your agent

Paste this into the agent's instruction file:

```markdown
When implementing a plan file with `- [ ]` steps: before starting a step, change its `[ ]` to `[/]`;
when the step is done, change it to `[x]`. Mark steps you work on in parallel `[/]` together.
Edit only the marker, never the step text.
```

"Edit only the marker" matters: the preview recognizes a step by its text, so rewording a step while it is in progress breaks the "just done" flash and the follow scroll for that step.

### Where each agent reads instructions

| Agent | File |
| --- | --- |
| Claude Code | `CLAUDE.md` in the repository root (or `~/.claude/CLAUDE.md` for all projects) |
| GitHub Copilot | `.github/copilot-instructions.md`, or `AGENTS.md` |
| OpenAI Codex | `AGENTS.md` |
| Cursor | `.cursor/rules/` or `AGENTS.md` |
| Gemini CLI | `GEMINI.md` |

Many other agents also read `AGENTS.md`, so it is a good default when a team uses several.

## A setup that works well

1. **Open the plan beside the agent.** Set `readMarkdown.preview.autoOpen` to `"beside"`, or run **Read Markdown: Open Preview to the Side** on the plan file.
2. **Stage the plan before the agent starts** (`git add plan.md`). Track changes compare against the git index, so the preview then shows exactly what the agent changed since: new steps in green, rewritten text struck through, reordered steps as moves. Stage again to reset the marks.
3. **Leave the file closed in the editor if you like.** The preview watches the file on disk, so it refreshes when the agent rewrites it, even with no text editor open.
4. **Let it follow.** The preview waits while you scroll or click, and never moves the source editor. Turn following off for one preview with the follow button in the toolbar (shown while a step is in progress).

## Reviewing what the agent wrote

- **Outline filter**: type in the outline to jump to a section of a long report.
- **Fold sections** you have read. Folded sections stay folded while the agent keeps editing.
- **Edit in place**: with `readMarkdown.edit.enabled`, fix a paragraph or tick a step without switching to the source. If the agent rewrites the file while a block is open, saving is refused so neither change is lost silently. See [Keyboard and Mouse](Keyboard-and-Mouse).
- **Gutter mode**: if inline marks are too busy for a big rewrite, the ± toolbar button switches that preview to change bars only.

## Turning it off

- `readMarkdown.tasks.progress: false` hides the progress bar and outline counts but keeps the highlight and follow.
- `readMarkdown.tasks.agentProgress: false` turns the whole feature off: `[/]` shows as plain text, as on GitHub.

Both are in the ⚙ panel under **Task lists**.
