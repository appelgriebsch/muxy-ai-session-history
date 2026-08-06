#!/usr/bin/env python3
"""Manage AI CLI sessions: rename or delete.

Usage:
  manage.py rename <cli> <session_id> <new_title>
  manage.py delete <cli> <session_id> [<cwd>]

Prints {"ok": true} on success or {"error": "<message>"} on failure.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def ok() -> int:
    print(json.dumps({"ok": True}))
    return 0


def err(message: str) -> int:
    print(json.dumps({"error": message}))
    return 1


def slugify(cwd: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in cwd)


def write_json_atomic(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def update_yaml_name(path: Path, new_title: str) -> bool:
    """Set top-level name: in a simple YAML file; create if missing."""
    lines: list[str] = []
    if path.is_file():
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            lines = []
    key_re = re.compile(r"^(\s*)name\s*:")
    replaced = False
    out_lines: list[str] = []
    safe = new_title.replace("\n", " ").replace('"', '\\"')
    for line in lines:
        if key_re.match(line) and not replaced:
            indent = key_re.match(line).group(1)
            out_lines.append(f'{indent}name: "{safe}"')
            replaced = True
        else:
            out_lines.append(line)
    if not replaced:
        out_lines.append(f'name: "{safe}"')
    tmp = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        try:
            if tmp.is_file():
                tmp.unlink()
        except OSError:
            pass
        return False
    return True


# ---------------------------------------------------------------------------
# Rename helpers
# ---------------------------------------------------------------------------


def rename_grok(session_id: str, new_title: str) -> int:
    root = Path.home() / ".grok" / "sessions"
    session_dir: Path | None = None
    try:
        for proj in root.iterdir() if root.is_dir() else []:
            candidate = proj / session_id if proj.is_dir() else None
            if candidate and candidate.is_dir():
                session_dir = candidate
                break
    except OSError as exc:
        return err(str(exc))
    if session_dir is None:
        return err(f"Grok session not found: {session_id}")
    summary = session_dir / "summary.json"
    try:
        data: dict = {}
        if summary.is_file():
            data = json.loads(summary.read_text(encoding="utf-8", errors="replace"))
        if not isinstance(data, dict):
            data = {}
        data["generated_title"] = new_title
        write_json_atomic(summary, data)
    except (OSError, json.JSONDecodeError) as exc:
        return err(str(exc))
    return ok()


def rename_codex(session_id: str, new_title: str) -> int:
    home_env = os.environ.get("CODEX_HOME")
    home = Path(home_env).expanduser() if home_env else Path.home() / ".codex"
    candidates: list[tuple[int, Path]] = []
    try:
        for path in home.iterdir():
            m = re.fullmatch(r"state_(\d+)\.sqlite", path.name)
            if m and path.is_file() and not path.is_symlink():
                candidates.append((int(m.group(1)), path))
    except OSError as exc:
        return err(str(exc))
    if not candidates:
        return err("No Codex state database found")
    db_path = max(candidates, key=lambda item: item[0])[1]
    try:
        with sqlite3.connect(str(db_path)) as db:
            cols = {row[1] for row in db.execute("PRAGMA table_info(threads)").fetchall()}
            if "title" not in cols:
                return err("Codex database does not have a title column")
            cursor = db.execute(
                "UPDATE threads SET title = ? WHERE id = ?", (new_title, session_id)
            )
            if cursor.rowcount == 0:
                return err(f"Codex session not found: {session_id}")
            db.commit()
    except sqlite3.Error as exc:
        return err(str(exc))
    return ok()


def rename_cursor(session_id: str, new_title: str) -> int:
    root = Path.home() / ".cursor" / "chats"
    session_dir: Path | None = None
    try:
        for proj in root.iterdir() if root.is_dir() else []:
            if not proj.is_dir():
                continue
            candidate = proj / session_id
            if candidate.is_dir():
                session_dir = candidate
                break
    except OSError as exc:
        return err(str(exc))
    if session_dir is None:
        return err(f"Cursor session not found: {session_id}")
    meta = session_dir / "meta.json"
    try:
        data: dict = {}
        if meta.is_file():
            data = json.loads(meta.read_text(encoding="utf-8", errors="replace"))
        if not isinstance(data, dict):
            data = {}
        data["title"] = new_title
        write_json_atomic(meta, data)
    except (OSError, json.JSONDecodeError) as exc:
        return err(str(exc))
    return ok()


def rename_copilot(session_id: str, new_title: str) -> int:
    """Multi-target rename: data.db title, workspace.yaml name, meta.json."""
    home_env = os.environ.get("COPILOT_HOME")
    home = Path(home_env).expanduser() if home_env else Path.home() / ".copilot"
    wrote = False
    errors: list[str] = []

    for db_name in ("data.db", "session-store.db"):
        db_path = home / db_name
        if not db_path.is_file():
            continue
        try:
            with sqlite3.connect(str(db_path)) as db:
                tables = {
                    r[0]
                    for r in db.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                if "sessions" not in tables:
                    continue
                cols = {r[1] for r in db.execute("PRAGMA table_info(sessions)").fetchall()}
                if "id" not in cols or "title" not in cols:
                    continue
                cursor = db.execute(
                    "UPDATE sessions SET title = ? WHERE id = ?",
                    (new_title, session_id),
                )
                if cursor.rowcount and cursor.rowcount > 0:
                    db.commit()
                    wrote = True
                else:
                    db.rollback()
        except sqlite3.Error as exc:
            errors.append(f"{db_name}: {exc}")

    state_dir = home / "session-state" / session_id
    if state_dir.is_dir():
        ws = state_dir / "workspace.yaml"
        if update_yaml_name(ws, new_title):
            wrote = True
        meta = state_dir / "meta.json"
        try:
            data: dict = {}
            if meta.is_file():
                loaded = json.loads(meta.read_text(encoding="utf-8", errors="replace"))
                if isinstance(loaded, dict):
                    data = loaded
            data["title"] = new_title
            data["name"] = new_title
            write_json_atomic(meta, data)
            wrote = True
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"meta.json: {exc}")
    elif not wrote:
        return err(f"Copilot session not found: {session_id}")

    if not wrote:
        detail = "; ".join(errors) if errors else "no writable title targets"
        return err(f"Could not rename Copilot session: {detail}")
    return ok()


# ---------------------------------------------------------------------------
# Delete helpers
# ---------------------------------------------------------------------------


def delete_grok(session_id: str) -> int:
    root = Path.home() / ".grok" / "sessions"
    session_dir: Path | None = None
    try:
        for proj in root.iterdir() if root.is_dir() else []:
            candidate = proj / session_id if proj.is_dir() else None
            if candidate and candidate.is_dir():
                session_dir = candidate
                break
    except OSError as exc:
        return err(str(exc))
    if session_dir is None:
        return err(f"Grok session not found: {session_id}")
    try:
        shutil.rmtree(str(session_dir))
    except OSError as exc:
        return err(str(exc))
    return ok()


def delete_claude(session_id: str, cwd: str | None) -> int:
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    base = Path(configured).expanduser() if configured else Path.home() / ".claude"
    projects = base / "projects"
    if not projects.is_dir():
        return err("Claude projects directory not found")
    target: Path | None = None
    try:
        search_dirs = []
        if cwd:
            expected = projects / slugify(cwd)
            if expected.is_dir():
                search_dirs.append(expected)
        for proj in sorted(projects.iterdir()):
            if proj.is_dir() and proj not in search_dirs:
                search_dirs.append(proj)
        for proj in search_dirs:
            candidate = proj / f"{session_id}.jsonl"
            if candidate.is_file():
                target = candidate
                break
    except OSError as exc:
        return err(str(exc))
    if target is None:
        return err(f"Claude session not found: {session_id}")
    try:
        target.unlink()
    except OSError as exc:
        return err(str(exc))
    return ok()


def delete_cursor(session_id: str) -> int:
    root = Path.home() / ".cursor" / "chats"
    session_dir: Path | None = None
    try:
        for proj in root.iterdir() if root.is_dir() else []:
            if not proj.is_dir():
                continue
            candidate = proj / session_id
            if candidate.is_dir():
                session_dir = candidate
                break
    except OSError as exc:
        return err(str(exc))
    if session_dir is None:
        return err(f"Cursor session not found: {session_id}")
    try:
        shutil.rmtree(str(session_dir))
    except OSError as exc:
        return err(str(exc))
    return ok()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 3:
        return err("Usage: manage.py <rename|delete> <cli> <session_id> [extra...]")

    action = args[0].strip().lower()
    cli = args[1].strip().lower()
    session_id = args[2].strip()

    # Align with JS SESSION_ID_RE: UUID or safe alnum ids (e.g. Copilot).
    if not UUID_RE.fullmatch(session_id) and not (
        re.fullmatch(r"[0-9a-zA-Z][0-9a-zA-Z._-]{5,128}", session_id)
        and not re.search(r"""[\s;'"$|<>]""", session_id)
    ):
        return err(f"Invalid session id: {session_id}")

    if action == "rename":
        if len(args) < 4:
            return err("rename requires a new title")
        new_title = args[3]
        if not new_title.strip():
            return err("New title must not be empty")
        if cli == "grok":
            return rename_grok(session_id, new_title)
        elif cli == "codex":
            return rename_codex(session_id, new_title)
        elif cli == "cursor":
            return rename_cursor(session_id, new_title)
        elif cli == "copilot":
            return rename_copilot(session_id, new_title)
        else:
            return err(f"Rename not supported for CLI: {cli}")

    elif action == "delete":
        cwd = args[3] if len(args) > 3 else None
        if cli == "grok":
            return delete_grok(session_id)
        elif cli == "claude":
            return delete_claude(session_id, cwd)
        elif cli == "cursor":
            return delete_cursor(session_id)
        else:
            return err(f"Delete not supported for CLI: {cli}")

    elif action == "archive":
        # Archive is Muxy extension storage only (managed in JS). Native CLI
        # flags are intentionally not written so sessions stay listable.
        return err("Native archive is not used; archive via extension storage")

    else:
        return err(f"Unknown action: {action}")


if __name__ == "__main__":
    raise SystemExit(main())
