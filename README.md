# AI Session History (Muxy extension)

Browse and resume AI coding-agent sessions for the **active worktree**, grouped by provider.

Supports **Grok**, **Claude Code**, **Codex**, **GitHub Copilot CLI**, and **Cursor Agent** when those binaries are on `PATH`.

## Features

- **Multi-provider list** — detects installed CLIs; default **All** view groups sessions by tool
- **Filter chips** — narrow to one provider
- **Resume** — opens a new terminal in the active worktree and runs the CLI’s resume command
- **Start new** — launches preferred / first-available CLI without resume
- **Palette** — **AI Sessions: Resume…** searchable modal across all installed providers

## Install (dev)

```bash
cd /path/to/ai-session-history
npm install
npm run build
```

In Muxy: **Extensions → Load Unpacked** → select this folder (or `dist/` after publish-style install). Grant permissions when prompted (`commands:exec`, `tabs:write`, etc.).

Toggle the panel with the topbar clock icon or **⌘⇧H**.

## How history is resolved

Sessions are **not** from `muxy.agents.list()` (live status only). The extension runs a Python scanner against each CLI’s on-disk store under your home directory, scoped to the active worktree path:

| CLI | Store (typical) | Resume command |
| --- | --- | --- |
| Grok | `~/.grok/sessions/<urlencode(cwd)>/` | `grok --resume <id>` |
| Claude | `~/.claude/projects/<slug>/` | `claude --resume <id>` |
| Codex | `~/.codex/` (SQLite / rollouts) | `codex resume <id>` |
| Copilot | `~/.copilot/` | `copilot --resume=<id>` |
| Cursor | `~/.cursor/chats/<md5(cwd)>/` | `cursor-agent --resume <id>` |

Only **installed** binaries appear as chips. Empty providers are omitted. If one adapter fails, others still show.

## Remote workspaces

On SSH / remote Muxy workspaces, `muxy.exec` runs on the **remote** host. You see remote session stores, not Mac-local history from a local-only CLI.

## Security

- Titles are sanitized for display (transcripts are untrusted).
- Resume commands use **session ids only** (validated), never free-text titles.
- First terminal auto-run requires Muxy’s **tabs.runCommand** consent (Allow & remember recommended per CLI).

## Development

```bash
npm run build   # required for Muxy Reload to pick up changes
npm test        # pure unit tests (no Muxy runtime)
```

Build copies `package.json` and `scripts/` into `dist/` (publish pipeline ships only `dist/`).

## Layout

```
src/panel/app.js           # panel UI (chips, groups, rows)
src/lib/sessions/          # detection, grouping, scanner bridge
src/lib/sessions/scanner.py
scripts/scan-sessions.py   # same scanner for palette / CLI use
scripts/resume-picker.js   # palette runScript modal
```
