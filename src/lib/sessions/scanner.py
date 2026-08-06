#!/usr/bin/env python3
"""List AI CLI sessions for a cwd. Prints JSON array of {id,title,updatedAt,branch,cli}.

Usage: scan-sessions.py <cli> <cwd>
  cli: grok | claude | codex | opencode | copilot | cursor
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
CODEX_ROLLOUT_RE = re.compile(
    r"^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-"
    r"([0-9a-fA-F-]{36})\.jsonl(?:\.zst)?$"
)
PER_GROUP_CAP = 25


def one_line(value: Any, limit: int = 120) -> str:
    text = " ".join(str(value if value is not None else "").split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def mtime_ms(path: Path) -> int:
    try:
        return int(path.stat().st_mtime * 1000)
    except OSError:
        return 0


def iso_to_ms(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        n = int(value)
        return n * 1000 if abs(n) < 1_000_000_000_000 else n
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def row(cli: str, sid: str, title: str, updated: int, branch: str | None = None) -> dict:
    return {
        "id": sid,
        "title": one_line(title) or "(untitled)",
        "updatedAt": int(updated or 0),
        "branch": branch if isinstance(branch, str) and branch else None,
        "cli": cli,
    }


def slugify(cwd: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in cwd)


def list_grok(cwd: str) -> list[dict]:
    root = Path.home() / ".grok" / "sessions" / quote(cwd, safe="")
    if not root.is_dir():
        return []
    out: list[dict] = []
    try:
        children = list(root.iterdir())
    except OSError:
        return []
    for child in children:
        if not child.is_dir() or child.is_symlink():
            continue
        if not UUID_RE.fullmatch(child.name):
            continue
        summary = child / "summary.json"
        title = "(untitled)"
        updated = mtime_ms(child)
        branch = None
        if summary.is_file():
            try:
                data = json.loads(summary.read_text(encoding="utf-8", errors="replace"))
            except (OSError, json.JSONDecodeError):
                data = {}
            if isinstance(data, dict):
                info = data.get("info") if isinstance(data.get("info"), dict) else {}
                sid = info.get("id") if isinstance(info.get("id"), str) else child.name
                title = (
                    data.get("generated_title")
                    or data.get("session_summary")
                    or data.get("agent_name")
                    or title
                )
                updated = iso_to_ms(data.get("updated_at") or data.get("last_active_at")) or updated
                out.append(row("grok", sid, str(title), updated, branch))
                continue
        out.append(row("grok", child.name, title, updated, branch))
    out.sort(key=lambda r: -r["updatedAt"])
    return out[:PER_GROUP_CAP]


def claude_title_from_jsonl(path: Path) -> tuple[str, str | None, str | None]:
    title = None
    cwd = None
    branch = None
    first_user = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for i, line in enumerate(handle):
                if i > 200:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(rec, dict):
                    continue
                if isinstance(rec.get("cwd"), str) and not cwd:
                    cwd = rec["cwd"]
                if isinstance(rec.get("gitBranch"), str) and not branch:
                    branch = rec["gitBranch"]
                t = rec.get("type")
                if t == "custom-title" and isinstance(rec.get("title") or rec.get("customTitle"), str):
                    title = rec.get("title") or rec.get("customTitle")
                elif t == "ai-title" and isinstance(rec.get("title") or rec.get("aiTitle"), str):
                    title = title or rec.get("title") or rec.get("aiTitle")
                elif t == "summary" and isinstance(rec.get("summary"), str):
                    title = title or rec["summary"]
                elif t == "user" and first_user is None:
                    msg = rec.get("message")
                    content = msg.get("content") if isinstance(msg, dict) else rec.get("content")
                    if isinstance(content, str):
                        first_user = content
                    elif isinstance(content, list):
                        parts = []
                        for block in content:
                            if isinstance(block, dict) and isinstance(block.get("text"), str):
                                parts.append(block["text"])
                            elif isinstance(block, str):
                                parts.append(block)
                        if parts:
                            first_user = "\n".join(parts)
    except OSError:
        pass
    return (title or first_user or "(untitled)", cwd, branch)


def list_claude(cwd: str) -> list[dict]:
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    base = Path(configured).expanduser() if configured else Path.home() / ".claude"
    projects = base / "projects"
    if not projects.is_dir():
        return []
    expected = projects / slugify(cwd)
    dirs: list[Path] = []
    if expected.is_dir() and not expected.is_symlink():
        dirs.append(expected)
    try:
        for path in sorted(projects.iterdir(), key=lambda p: p.name):
            if path != expected and path.is_dir() and not path.is_symlink():
                dirs.append(path)
    except OSError:
        pass
    out: list[dict] = []
    seen: set[str] = set()
    for project in dirs:
        try:
            files = list(project.iterdir())
        except OSError:
            continue
        for path in files:
            if (
                path.is_symlink()
                or not path.is_file()
                or path.suffix != ".jsonl"
                or not UUID_RE.fullmatch(path.stem)
                or path.stem in seen
            ):
                continue
            title, stored_cwd, branch = claude_title_from_jsonl(path)
            if stored_cwd and os.path.normpath(stored_cwd) != os.path.normpath(cwd):
                continue
            if not stored_cwd and project != expected:
                continue
            seen.add(path.stem)
            out.append(row("claude", path.stem, title, mtime_ms(path), branch))
    out.sort(key=lambda r: -r["updatedAt"])
    return out[:PER_GROUP_CAP]


def codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".codex"


def list_codex_db(home: Path, cwd: str) -> list[dict] | None:
    candidates: list[tuple[int, Path]] = []
    try:
        for path in home.iterdir():
            m = re.fullmatch(r"state_(\d+)\.sqlite", path.name)
            if m and path.is_file() and not path.is_symlink():
                candidates.append((int(m.group(1)), path))
    except OSError:
        return None
    if not candidates:
        return None
    db_path = max(candidates, key=lambda item: item[0])[1]
    try:
        uri = f"file:{db_path}?mode=ro"
        with sqlite3.connect(uri, uri=True) as db:
            cols = {
                row[1]
                for row in db.execute("PRAGMA table_info(threads)").fetchall()
            }
            required = {"id", "rollout_path", "source", "cwd", "archived"}
            if not required.issubset(cols):
                return None
            updated_col = (
                "updated_at_ms"
                if "updated_at_ms" in cols
                else "updated_at"
                if "updated_at" in cols
                else None
            )
            if not updated_col:
                return None
            title_col = "title" if "title" in cols else "''"
            first_col = "first_user_message" if "first_user_message" in cols else "''"
            branch_col = "git_branch" if "git_branch" in cols else "NULL"
            rows = db.execute(
                f"SELECT id, {updated_col}, {title_col}, {first_col}, {branch_col} "
                f"FROM threads WHERE archived = 0 AND cwd = ? "
                f"AND source IN ('cli', 'vscode') "
                f"ORDER BY {updated_col} DESC LIMIT ?",
                (cwd, PER_GROUP_CAP),
            )
            out: list[dict] = []
            for sid, raw_updated, raw_title, first_user, git in rows:
                if not isinstance(sid, str) or not UUID_RE.fullmatch(sid):
                    continue
                title = raw_title if isinstance(raw_title, str) and raw_title.strip() else first_user
                updated = iso_to_ms(raw_updated) or 0
                out.append(
                    row(
                        "codex",
                        sid,
                        str(title) if title else "(untitled)",
                        updated,
                        git if isinstance(git, str) else None,
                    )
                )
            return out
    except sqlite3.Error:
        return None


def list_codex_files(home: Path, cwd: str) -> list[dict]:
    out: list[dict] = []
    root = home / "sessions"
    if not root.is_dir():
        return []
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [
            name
            for name in dirnames
            if not (Path(directory) / name).is_symlink()
        ]
        for filename in filenames:
            if filename.endswith(".zst"):
                continue
            m = CODEX_ROLLOUT_RE.fullmatch(filename)
            if not m:
                continue
            path = Path(directory) / filename
            if path.is_symlink():
                continue
            try:
                with path.open("r", encoding="utf-8", errors="replace") as handle:
                    head = handle.read(64_000)
            except OSError:
                continue
            payload = None
            for line in head.splitlines()[:20]:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (
                    isinstance(rec, dict)
                    and rec.get("type") == "session_meta"
                    and isinstance(rec.get("payload"), dict)
                ):
                    payload = rec["payload"]
                    break
            if not payload or payload.get("cwd") != cwd:
                continue
            if payload.get("source") not in {"cli", "vscode", None}:
                continue
            sid = payload.get("id") or m.group(1)
            if not isinstance(sid, str) or not UUID_RE.fullmatch(sid):
                continue
            branch = None
            git = payload.get("git")
            if isinstance(git, dict) and isinstance(git.get("branch"), str):
                branch = git["branch"]
            out.append(row("codex", sid, "(untitled)", mtime_ms(path), branch))
    out.sort(key=lambda r: -r["updatedAt"])
    return out[:PER_GROUP_CAP]


def list_codex(cwd: str) -> list[dict]:
    home = codex_home()
    db_rows = list_codex_db(home, cwd)
    if db_rows is not None:
        return db_rows
    return list_codex_files(home, cwd)


def opencode_home() -> Path:
    configured = os.environ.get("OPENCODE_DATA_DIR")
    if configured:
        first = configured.split(",")[0].strip()
        if first:
            return Path(first).expanduser()
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "share"
    return base / "opencode"


def list_opencode(cwd: str) -> list[dict]:
    db_path = opencode_home() / "opencode.db"
    if not db_path.is_file():
        return []
    try:
        uri = f"file:{db_path}?mode=ro"
        with sqlite3.connect(uri, uri=True) as db:
            cols = {row[1] for row in db.execute("PRAGMA table_info(session)").fetchall()}
            required = {"id", "directory", "time_updated"}
            if not required.issubset(cols):
                return []
            rows = (
                db.execute(
                    "SELECT id, title, time_updated FROM session "
                    "WHERE directory = ? ORDER BY time_updated DESC LIMIT ?",
                    (cwd, PER_GROUP_CAP),
                )
                if "title" in cols
                else db.execute(
                    "SELECT id, '' AS title, time_updated FROM session "
                    "WHERE directory = ? ORDER BY time_updated DESC LIMIT ?",
                    (cwd, PER_GROUP_CAP),
                )
            )
            out: list[dict] = []
            for sid, title, updated in rows:
                if not isinstance(sid, str) or not sid:
                    continue
                out.append(
                    row(
                        "opencode",
                        sid,
                        str(title) if isinstance(title, str) and title.strip() else "(untitled)",
                        iso_to_ms(updated) or 0,
                    )
                )
            return out
    except sqlite3.Error:
        return []


def list_copilot(cwd: str) -> list[dict]:
    home_env = os.environ.get("COPILOT_HOME")
    home = Path(home_env).expanduser() if home_env else Path.home() / ".copilot"
    out: list[dict] = []
    warned_unfiltered = False

    db_path = home / "session-store.db"
    if db_path.is_file():
        try:
            uri = f"file:{db_path}?mode=ro"
            with sqlite3.connect(uri, uri=True) as db:
                tables = {
                    r[0]
                    for r in db.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                for table in ("sessions", "session", "session_docs", "chronicle"):
                    if table not in tables:
                        continue
                    cols = {r[1] for r in db.execute(f"PRAGMA table_info({table})").fetchall()}
                    id_col = next((c for c in ("id", "session_id", "sessionId") if c in cols), None)
                    if not id_col:
                        continue
                    title_col = next(
                        (c for c in ("title", "name", "summary") if c in cols),
                        None,
                    )
                    updated_col = next(
                        (
                            c
                            for c in (
                                "updated_at",
                                "updatedAt",
                                "updated_at_ms",
                                "mtime",
                                "last_active_at",
                            )
                            if c in cols
                        ),
                        None,
                    )
                    path_col = next(
                        (
                            c
                            for c in (
                                "cwd",
                                "workspace",
                                "workspace_path",
                                "workspacePath",
                                "path",
                            )
                            if c in cols
                        ),
                        None,
                    )
                    select_cols = [id_col, title_col or "NULL", updated_col or "NULL", path_col or "NULL"]
                    sql = f"SELECT {', '.join(select_cols)} FROM {table} LIMIT 200"
                    for sid, title, updated, path_val in db.execute(sql):
                        if not isinstance(sid, str) or not sid:
                            continue
                        if path_val is not None and isinstance(path_val, str):
                            if os.path.normpath(path_val) != os.path.normpath(cwd) and cwd not in path_val:
                                continue
                        elif path_col is None:
                            warned_unfiltered = True
                        out.append(
                            row(
                                "copilot",
                                sid,
                                str(title) if title else "(untitled)",
                                iso_to_ms(updated) or 0,
                                None,
                            )
                        )
                    if out:
                        break
        except sqlite3.Error:
            pass

    state = home / "session-state"
    if state.is_dir() and len(out) < PER_GROUP_CAP:
        try:
            children = list(state.iterdir())
        except OSError:
            children = []
        seen = {r["id"] for r in out}
        for child in children:
            if not child.is_dir() or child.is_symlink() or child.name in seen:
                continue
            ws = child / "workspace.yaml"
            match = True
            if ws.is_file():
                try:
                    text = ws.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    text = ""
                if cwd not in text and os.path.normpath(cwd) not in text:
                    match = False
            else:
                match = True
                warned_unfiltered = True
            if not match:
                continue
            title = child.name
            meta = child / "meta.json"
            if meta.is_file():
                try:
                    data = json.loads(meta.read_text(encoding="utf-8", errors="replace"))
                    if isinstance(data, dict):
                        title = data.get("name") or data.get("title") or title
                except (OSError, json.JSONDecodeError):
                    pass
            out.append(row("copilot", child.name, str(title), mtime_ms(child), None))

    if warned_unfiltered and out:
        for r in out:
            if not str(r["title"]).startswith("[unfiltered]"):
                r["title"] = f"[unfiltered] {r['title']}"

    out.sort(key=lambda r: -r["updatedAt"])
    return out[:PER_GROUP_CAP]


def list_cursor(cwd: str) -> list[dict]:
    root = Path.home() / ".cursor" / "chats" / hashlib.md5(cwd.encode("utf-8", errors="replace")).hexdigest()
    if not root.is_dir():
        return []
    out: list[dict] = []
    try:
        children = list(root.iterdir())
    except OSError:
        return []
    for child in children:
        if not child.is_dir() or child.is_symlink():
            continue
        sid = child.name
        title = "(untitled)"
        updated = mtime_ms(child)
        branch = None
        meta = child / "meta.json"
        if meta.is_file():
            try:
                data = json.loads(meta.read_text(encoding="utf-8", errors="replace"))
            except (OSError, json.JSONDecodeError):
                data = None
            if isinstance(data, dict):
                title = data.get("title") or data.get("name") or title
                updated = iso_to_ms(data.get("updatedAtMs") or data.get("updatedAt") or data.get("updated_at")) or updated
                if isinstance(data.get("branch"), str):
                    branch = data["branch"]
        out.append(row("cursor", sid, str(title), updated, branch))
    out.sort(key=lambda r: -r["updatedAt"])
    return out[:PER_GROUP_CAP]


def main() -> int:
    if len(sys.argv) < 3:
        print("[]")
        return 2
    cli = sys.argv[1].strip().lower()
    cwd = sys.argv[2]
    try:
        if cli == "grok":
            sessions = list_grok(cwd)
        elif cli == "claude":
            sessions = list_claude(cwd)
        elif cli == "codex":
            sessions = list_codex(cwd)
        elif cli == "opencode":
            sessions = list_opencode(cwd)
        elif cli == "copilot":
            sessions = list_copilot(cwd)
        elif cli == "cursor":
            sessions = list_cursor(cwd)
        else:
            print(json.dumps({"error": f"unknown cli: {cli}"}))
            return 2
        print(json.dumps(sessions, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
