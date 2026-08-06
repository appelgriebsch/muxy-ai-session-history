#!/usr/bin/env python3
"""List AI CLI sessions for a cwd. Prints JSON array of {id,title,updatedAt,branch,cli}.

Usage: scan-sessions.py <cli> <cwd>
  cli: grok | claude | codex | copilot | cursor
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


def row(
    cli: str,
    sid: str,
    title: str,
    updated: int,
    branch: str | None = None,
    cwd: str | None = None,
) -> dict:
    return {
        "id": sid,
        "title": one_line(title) or "(untitled)",
        "updatedAt": int(updated or 0),
        "branch": branch if isinstance(branch, str) and branch else None,
        "cwd": cwd if isinstance(cwd, str) and cwd else None,
        "cli": cli,
    }


SESSION_ID_RE = re.compile(r"^[0-9a-zA-Z][0-9a-zA-Z._-]{5,128}$")
WEAK_TITLES = {"", "(untitled)", "untitled", "session"}
# Copilot UI/draft placeholders — never CLI-resumable via --resume=<id>.
COPILOT_STUB_PREFIXES = ("optimistic-chat-", "pending-session")


def safe_session_id(sid: str) -> bool:
    if not isinstance(sid, str) or not sid:
        return False
    if UUID_RE.fullmatch(sid):
        return True
    return bool(SESSION_ID_RE.fullmatch(sid)) and not re.search(r"""[\s;'"$|<>]""", sid)


def is_copilot_stub_id(sid: str) -> bool:
    if not isinstance(sid, str) or not sid:
        return True
    lower = sid.lower()
    return any(lower.startswith(prefix) for prefix in COPILOT_STUB_PREFIXES)


def events_nonempty(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def load_copilot_turn_ids(home: Path) -> set[str]:
    """Session ids with at least one turn row (strong resume evidence)."""
    found: set[str] = set()
    for db_name in ("session-store.db", "data.db"):
        db_path = home / db_name
        if not db_path.is_file():
            continue
        try:
            uri = f"file:{db_path}?mode=ro"
            with sqlite3.connect(uri, uri=True) as db:
                try:
                    db.execute("PRAGMA busy_timeout=100")
                except sqlite3.Error:
                    pass
                tables = {
                    r[0]
                    for r in db.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                if "turns" not in tables:
                    continue
                cols = {
                    r[1] for r in db.execute("PRAGMA table_info(turns)").fetchall()
                }
                sid_col = next(
                    (c for c in ("session_id", "sessionId", "id") if c in cols),
                    None,
                )
                if not sid_col:
                    continue
                for (sid,) in db.execute(
                    f"SELECT DISTINCT {sid_col} FROM turns WHERE {sid_col} IS NOT NULL"
                ):
                    if isinstance(sid, str) and sid:
                        found.add(sid)
        except sqlite3.Error:
            continue
    return found


def is_weak_title(value: Any, sid: str) -> bool:
    if value is None:
        return True
    text = " ".join(str(value).split()).strip()
    if not text:
        return True
    if text == sid:
        return True
    if text.lower() in WEAK_TITLES:
        return True
    if UUID_RE.fullmatch(text):
        return True
    if re.fullmatch(r"[0-9a-fA-F]{16,}", text):
        return True
    return False


def short_id(sid: str) -> str:
    if len(sid) > 12:
        return f"{sid[:8]}…{sid[-4:]}"
    return sid


def cwd_basename(path: str | None) -> str | None:
    if not path or not isinstance(path, str):
        return None
    base = os.path.basename(os.path.normpath(path.rstrip(os.sep)))
    return base or None


def parse_simple_yaml(path: Path) -> dict[str, str]:
    """Best-effort flat key: value parser (workspace.yaml)."""
    out: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    for line in text.splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or ":" not in raw:
            continue
        key, _, val = raw.partition(":")
        key = key.strip()
        val = val.strip().strip("\"'")
        if key:
            out[key] = val
    return out


def first_user_message_from_events(path: Path, limit: int = 120) -> str | None:
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for i, line in enumerate(handle):
                if i > 400:
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
                role = str(rec.get("role") or rec.get("type") or "").lower()
                if role not in {"user", "user.message", "human"}:
                    # Copilot CLI events often use type like "user.message"
                    t = str(rec.get("type") or "").lower()
                    if "user" not in t or "assistant" in t:
                        continue
                content = (
                    rec.get("content")
                    or rec.get("text")
                    or rec.get("message")
                    or rec.get("user_content")
                )
                if isinstance(content, list):
                    parts = []
                    for part in content:
                        if isinstance(part, str):
                            parts.append(part)
                        elif isinstance(part, dict):
                            parts.append(str(part.get("text") or part.get("content") or ""))
                    content = " ".join(parts)
                if isinstance(content, dict):
                    content = content.get("text") or content.get("content")
                if isinstance(content, str) and content.strip():
                    return one_line(content, limit)
    except OSError:
        return None
    return None


def pick_display_title(
    sid: str,
    *,
    db_title: Any = None,
    yaml_name: Any = None,
    meta_title: Any = None,
    first_user: Any = None,
    cwd: str | None = None,
    branch: str | None = None,
) -> str:
    candidates = [db_title, yaml_name, meta_title, first_user]
    for cand in candidates:
        if not is_weak_title(cand, sid):
            return one_line(cand) or f"Copilot · {short_id(sid)}"
    base = cwd_basename(cwd)
    if base and branch:
        return one_line(f"{base} · {branch}")
    if base:
        return one_line(base)
    if branch:
        return one_line(branch)
    return f"Copilot · {short_id(sid)}"


def path_matches_cwd(path_val: str | None, cwd: str) -> bool:
    if not path_val or not isinstance(path_val, str):
        return False
    try:
        return os.path.normpath(path_val) == os.path.normpath(cwd) or cwd in path_val
    except (TypeError, ValueError):
        return False


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
            # Do not require/filter native `archived` — panel archive is Muxy-only.
            required = {"id", "source", "cwd"}
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
                f"FROM threads WHERE cwd = ? "
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


def _merge_copilot_session(
    store: dict[str, dict[str, Any]],
    sid: str,
    *,
    db_title: Any = None,
    yaml_name: Any = None,
    meta_title: Any = None,
    first_user: Any = None,
    cwd_val: str | None = None,
    branch: str | None = None,
    updated: int = 0,
    resumable: bool = False,
) -> None:
    if not safe_session_id(sid):
        return
    entry = store.setdefault(
        sid,
        {
            "db_title": None,
            "yaml_name": None,
            "meta_title": None,
            "first_user": None,
            "cwd": None,
            "branch": None,
            "updated": 0,
            "resumable": False,
        },
    )
    if db_title is not None and entry["db_title"] is None:
        entry["db_title"] = db_title
    if yaml_name is not None and entry["yaml_name"] is None:
        entry["yaml_name"] = yaml_name
    if meta_title is not None and entry["meta_title"] is None:
        entry["meta_title"] = meta_title
    if first_user is not None and entry["first_user"] is None:
        entry["first_user"] = first_user
    if cwd_val and not entry["cwd"]:
        entry["cwd"] = cwd_val
    if branch and not entry["branch"]:
        entry["branch"] = branch
    if updated and updated > (entry["updated"] or 0):
        entry["updated"] = updated
    if resumable:
        entry["resumable"] = True


def _read_copilot_data_db(home: Path, cwd: str, store: dict[str, dict[str, Any]]) -> None:
    for db_name in ("data.db", "session-store.db"):
        db_path = home / db_name
        if not db_path.is_file():
            continue
        try:
            uri = f"file:{db_path}?mode=ro"
            with sqlite3.connect(uri, uri=True) as db:
                tables = {
                    r[0]
                    for r in db.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                # Prefer sessions + workspaces join when present (desktop + CLI titles).
                if "sessions" in tables:
                    scols = {
                        r[1] for r in db.execute("PRAGMA table_info(sessions)").fetchall()
                    }
                    if "id" in scols:
                        title_expr = next(
                            (c for c in ("title", "summary", "name") if c in scols),
                            "NULL",
                        )
                        updated_expr = next(
                            (
                                c
                                for c in (
                                    "updated_at",
                                    "updatedAt",
                                    "updated_at_ms",
                                    "last_active_at",
                                    "created_at",
                                )
                                if c in scols
                            ),
                            "NULL",
                        )
                        sess_path_col = next(
                            (
                                c
                                for c in (
                                    "cwd",
                                    "path",
                                    "workspace_path",
                                    "workspacePath",
                                    "directory",
                                )
                                if c in scols
                            ),
                            None,
                        )
                        sess_branch_col = next(
                            (c for c in ("branch", "git_branch") if c in scols),
                            None,
                        )
                        ws_by_sid: dict[str, tuple[str | None, str | None]] = {}
                        if "workspaces" in tables:
                            wcols = {
                                r[1]
                                for r in db.execute(
                                    "PRAGMA table_info(workspaces)"
                                ).fetchall()
                            }
                            sid_col = next(
                                (
                                    c
                                    for c in ("session_id", "sessionId", "id")
                                    if c in wcols
                                ),
                                None,
                            )
                            path_col = next(
                                (
                                    c
                                    for c in (
                                        "cwd",
                                        "path",
                                        "workspace_path",
                                        "workspacePath",
                                        "directory",
                                    )
                                    if c in wcols
                                ),
                                None,
                            )
                            branch_col = next(
                                (c for c in ("branch", "git_branch") if c in wcols),
                                None,
                            )
                            if sid_col:
                                sel = [
                                    sid_col,
                                    path_col or "NULL",
                                    branch_col or "NULL",
                                ]
                                for wsid, wpath, wbranch in db.execute(
                                    f"SELECT {', '.join(sel)} FROM workspaces LIMIT 500"
                                ):
                                    if isinstance(wsid, str):
                                        ws_by_sid[wsid] = (
                                            wpath if isinstance(wpath, str) else None,
                                            wbranch if isinstance(wbranch, str) else None,
                                        )
                        sql = (
                            f"SELECT id, {title_expr}, {updated_expr}, "
                            f"{sess_path_col or 'NULL'}, {sess_branch_col or 'NULL'} "
                            f"FROM sessions ORDER BY rowid DESC LIMIT 300"
                        )
                        for sid, title, updated, sess_path, sess_branch in db.execute(sql):
                            if not isinstance(sid, str):
                                continue
                            wpath, wbranch = ws_by_sid.get(sid, (None, None))
                            path_val = (
                                wpath
                                if wpath
                                else sess_path if isinstance(sess_path, str) else None
                            )
                            branch_val = (
                                wbranch
                                if wbranch
                                else sess_branch if isinstance(sess_branch, str) else None
                            )
                            # Enrich titles only for sessions already proven resumable.
                            # Never mark resumable from DB cwd match alone.
                            if sid in store:
                                _merge_copilot_session(
                                    store,
                                    sid,
                                    db_title=title,
                                    cwd_val=path_val,
                                    branch=branch_val,
                                    updated=iso_to_ms(updated) or 0,
                                    resumable=False,
                                )
                        continue

                for table in ("session", "session_docs", "chronicle", "sessions"):
                    if table not in tables:
                        continue
                    cols = {
                        r[1] for r in db.execute(f"PRAGMA table_info({table})").fetchall()
                    }
                    id_col = next(
                        (c for c in ("id", "session_id", "sessionId") if c in cols),
                        None,
                    )
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
                    select_cols = [
                        id_col,
                        title_col or "NULL",
                        updated_col or "NULL",
                        path_col or "NULL",
                    ]
                    sql = (
                        f"SELECT {', '.join(select_cols)} FROM {table} "
                        f"ORDER BY rowid DESC LIMIT 200"
                    )
                    for sid, title, updated, path_val in db.execute(sql):
                        if not isinstance(sid, str) or not sid:
                            continue
                        if sid not in store:
                            continue
                        _merge_copilot_session(
                            store,
                            sid,
                            db_title=title,
                            cwd_val=path_val if isinstance(path_val, str) else None,
                            updated=iso_to_ms(updated) or 0,
                            resumable=False,
                        )
        except sqlite3.Error:
            continue


def list_copilot(cwd: str) -> list[dict]:
    """CLI-resumable Copilot sessions with rich titles (never bare UUID primary)."""
    home_env = os.environ.get("COPILOT_HOME")
    home = Path(home_env).expanduser() if home_env else Path.home() / ".copilot"
    store: dict[str, dict[str, Any]] = {}
    turn_ids = load_copilot_turn_ids(home)

    state = home / "session-state"
    if state.is_dir():
        try:
            children = list(state.iterdir())
        except OSError:
            children = []
        for child in children:
            if not child.is_dir() or child.is_symlink():
                continue
            sid = child.name
            if not safe_session_id(sid) or is_copilot_stub_id(sid):
                continue

            ws_path = child / "workspace.yaml"
            yaml_data = parse_simple_yaml(ws_path) if ws_path.is_file() else {}
            session_cwd = yaml_data.get("cwd") or yaml_data.get("path")
            branch = yaml_data.get("branch") or yaml_data.get("git_branch")
            yaml_name = yaml_data.get("name") or yaml_data.get("title")

            meta_title = None
            meta = child / "meta.json"
            if meta.is_file():
                try:
                    data = json.loads(meta.read_text(encoding="utf-8", errors="replace"))
                    if isinstance(data, dict):
                        meta_title = data.get("title") or data.get("name")
                        if not session_cwd and isinstance(data.get("cwd"), str):
                            session_cwd = data["cwd"]
                        if not branch and isinstance(data.get("branch"), str):
                            branch = data["branch"]
                except (OSError, json.JSONDecodeError):
                    pass

            # Cwd-scoped list: missing cwd must not leak global stubs into every project.
            if not session_cwd or not path_matches_cwd(session_cwd, cwd):
                continue

            has_events = events_nonempty(child / "events.jsonl")
            has_turns = sid in turn_ids
            if not has_events and not has_turns:
                continue

            first_user = (
                first_user_message_from_events(child / "events.jsonl")
                if has_events
                else None
            )
            _merge_copilot_session(
                store,
                sid,
                yaml_name=yaml_name,
                meta_title=meta_title,
                first_user=first_user,
                cwd_val=session_cwd,
                branch=branch,
                updated=mtime_ms(child),
                resumable=True,
            )

    _read_copilot_data_db(home, cwd, store)

    out: list[dict] = []
    for sid, meta in store.items():
        if not meta.get("resumable"):
            continue
        title = pick_display_title(
            sid,
            db_title=meta.get("db_title"),
            yaml_name=meta.get("yaml_name"),
            meta_title=meta.get("meta_title"),
            first_user=meta.get("first_user"),
            cwd=meta.get("cwd"),
            branch=meta.get("branch"),
        )
        out.append(
            row(
                "copilot",
                sid,
                title,
                int(meta.get("updated") or 0),
                meta.get("branch"),
                meta.get("cwd"),
            )
        )

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
