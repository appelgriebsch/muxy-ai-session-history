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
        summary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
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
        meta.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, json.JSONDecodeError) as exc:
        return err(str(exc))
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
# Archive helpers (for CLIs with native DB archive support)
# ---------------------------------------------------------------------------


def archive_codex(session_id: str, archived: bool) -> int:
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
            if "archived" not in cols:
                return err("Codex database does not have an archived column")
            cursor = db.execute(
                "UPDATE threads SET archived = ? WHERE id = ?",
                (1 if archived else 0, session_id),
            )
            if cursor.rowcount == 0:
                return err(f"Codex session not found: {session_id}")
            db.commit()
    except sqlite3.Error as exc:
        return err(str(exc))
    return ok()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 3:
        return err("Usage: manage.py <rename|delete|archive> <cli> <session_id> [extra...]")

    action = args[0].strip().lower()
    cli = args[1].strip().lower()
    session_id = args[2].strip()

    if not UUID_RE.fullmatch(session_id):
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
        archived = args[3].lower() not in ("0", "false", "no") if len(args) > 3 else True
        if cli == "codex":
            return archive_codex(session_id, archived)
        else:
            return err(f"Native archive not supported for CLI: {cli}")

    else:
        return err(f"Unknown action: {action}")


if __name__ == "__main__":
    raise SystemExit(main())
