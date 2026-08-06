# AI Session History (Muxy extension)

Browse and resume AI coding-agent sessions for the **active worktree**, grouped by provider.

Supports **Grok**, **Claude Code**, **Codex**, **GitHub Copilot CLI**, and **Cursor Agent** when those binaries are on `PATH`.

## Features

- **Multi-provider list** — detects installed CLIs; default **All** view groups sessions by tool
- **Filter chips** — Muxy provider icons + labels; narrow to one provider
- **Readable titles** — Copilot uses `data.db` / `workspace.yaml` / first user message (never bare UUID alone)
- **Rename / archive / delete** — capability-gated per CLI; rename and delete confirm are **inline in the panel** (no host prompt/confirm UI); **archive is Muxy-only** (does not flip native Codex `archived`)
- **Resume** — opens a new terminal in the active worktree and runs the CLI’s resume command
- **Start new** — split button: primary starts the last-chosen / first-available CLI; chevron picks which CLI (stored in extension storage)
- **Palette** — **AI Sessions: Resume…** searchable modal across all installed providers

## Requirements

- **Python 3** on PATH (`python3`) on the host where sessions live (local or SSH remote). The panel runs scanners via `muxy.exec(["python3", "-", …], { stdin })`.

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
| Copilot | `~/.copilot/session-state/`, `data.db` | `copilot --resume=<id>` |
| Cursor | `~/.cursor/chats/<md5(cwd)>/` | `cursor-agent --resume <id>` |

### Capabilities

| CLI | Rename | Archive (Muxy storage) | Delete |
| --- | --- | --- | --- |
| Grok | yes | yes | yes |
| Claude | no | yes | yes |
| Codex | yes (`threads.title`) | yes (not native DB flag) | no |
| Copilot | yes (db + workspace.yaml + meta) | yes | no |
| Cursor | yes | yes | yes |

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
src/panel/app.js              # panel UI (chips, groups, rows)
src/lib/sessions/             # detection, grouping, manage/scan bridge
src/lib/sessions/scanner.py   # authoritative scanner (also embedded in picker)
src/lib/sessions/manage.py    # rename / delete host worker
src/lib/provider-icons.js     # vendored monochrome Muxy ProviderIcons
src/assets/provider-icons/    # SVG sources (re-copy from muxy core if needed)
scripts/scan-sessions.py      # synced copy of scanner.py for CLI / dist
scripts/resume-picker.js      # palette runScript modal
doc/                          # implementation plans & research
```
