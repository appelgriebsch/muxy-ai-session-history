#!/usr/bin/env python3
"""Round-trip tests for manage.py rename (and basic delete/unsupported paths)."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import urllib.parse
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
MANAGE_PATH = ROOT / "src" / "lib" / "sessions" / "manage.py"

SID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
SID2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


def load_manage():
    spec = importlib.util.spec_from_file_location("session_manage", MANAGE_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


mg = load_manage()


def run_main(argv: list[str]) -> tuple[int, dict]:
    buf = io.StringIO()
    with mock.patch.object(sys, "argv", ["manage.py", *argv]), redirect_stdout(buf):
        code = mg.main()
    raw = buf.getvalue().strip()
    data = json.loads(raw) if raw else {}
    return code, data


class ManageRenameTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._env = os.environ.copy()
        os.environ["HOME"] = str(self.home)
        # Isolate optional overrides used by manage.py
        os.environ.pop("CODEX_HOME", None)
        os.environ.pop("COPILOT_HOME", None)
        os.environ.pop("CLAUDE_CONFIG_DIR", None)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env)
        self._tmp.cleanup()

    # --- validation ---

    def test_rename_requires_title(self) -> None:
        code, data = run_main(["rename", "grok", SID])
        self.assertNotEqual(code, 0)
        self.assertIn("title", data.get("error", "").lower())

    def test_rename_rejects_whitespace_title(self) -> None:
        code, data = run_main(["rename", "grok", SID, "   "])
        self.assertNotEqual(code, 0)
        self.assertIn("empty", data.get("error", "").lower())

    def test_rename_rejects_invalid_session_id(self) -> None:
        code, data = run_main(["rename", "grok", "short", "Title"])
        self.assertNotEqual(code, 0)
        self.assertIn("invalid", data.get("error", "").lower())

    def test_rename_claude_unsupported(self) -> None:
        code, data = run_main(["rename", "claude", SID, "Nope"])
        self.assertNotEqual(code, 0)
        self.assertIn("not supported", data.get("error", "").lower())

    # --- grok ---

    def test_rename_grok_round_trip(self) -> None:
        proj = self.home / ".grok" / "sessions" / urllib.parse.quote("/tmp/proj", safe="")
        session = proj / SID
        session.mkdir(parents=True)
        summary = session / "summary.json"
        summary.write_text(
            json.dumps({"generated_title": "Old", "info": {"id": SID}}),
            encoding="utf-8",
        )
        title = 'New multi-word "quoted" café'
        code, data = run_main(["rename", "grok", SID, title])
        self.assertEqual(code, 0, data)
        self.assertTrue(data.get("ok"))
        loaded = json.loads(summary.read_text(encoding="utf-8"))
        self.assertEqual(loaded["generated_title"], title)

    def test_rename_grok_missing(self) -> None:
        code, data = run_main(["rename", "grok", SID, "X"])
        self.assertNotEqual(code, 0)
        self.assertIn("not found", data.get("error", "").lower())

    # --- cursor ---

    def test_rename_cursor_round_trip(self) -> None:
        session = self.home / ".cursor" / "chats" / "projhash" / SID
        session.mkdir(parents=True)
        meta = session / "meta.json"
        meta.write_text(json.dumps({"title": "Old"}), encoding="utf-8")
        code, data = run_main(["rename", "cursor", SID, "Cursor New"])
        self.assertEqual(code, 0, data)
        loaded = json.loads(meta.read_text(encoding="utf-8"))
        self.assertEqual(loaded["title"], "Cursor New")

    # --- codex ---

    def test_rename_codex_round_trip(self) -> None:
        codex = self.home / ".codex"
        codex.mkdir()
        db_path = codex / "state_1.sqlite"
        with sqlite3.connect(db_path) as db:
            db.execute(
                "CREATE TABLE threads ("
                "id TEXT PRIMARY KEY, title TEXT, cwd TEXT, source TEXT, archived INT)"
            )
            db.execute(
                "INSERT INTO threads (id, title, cwd, source, archived) "
                "VALUES (?, 'Old', '/tmp', 'cli', 0)",
                (SID,),
            )
            db.commit()
        code, data = run_main(["rename", "codex", SID, "Codex Title"])
        self.assertEqual(code, 0, data)
        with sqlite3.connect(db_path) as db:
            row = db.execute("SELECT title FROM threads WHERE id = ?", (SID,)).fetchone()
        self.assertEqual(row[0], "Codex Title")

    def test_rename_codex_missing_id(self) -> None:
        codex = self.home / ".codex"
        codex.mkdir()
        db_path = codex / "state_1.sqlite"
        with sqlite3.connect(db_path) as db:
            db.execute(
                "CREATE TABLE threads ("
                "id TEXT PRIMARY KEY, title TEXT, cwd TEXT, source TEXT, archived INT)"
            )
            db.commit()
        code, data = run_main(["rename", "codex", SID, "X"])
        self.assertNotEqual(code, 0)
        self.assertIn("not found", data.get("error", "").lower())

    # --- copilot ---

    def test_rename_copilot_multi_target(self) -> None:
        copilot = self.home / ".copilot"
        state = copilot / "session-state" / SID
        state.mkdir(parents=True)
        (state / "workspace.yaml").write_text(
            f"id: {SID}\ncwd: /tmp/p\nname: OldName\n",
            encoding="utf-8",
        )
        (state / "meta.json").write_text(json.dumps({"title": "Old"}), encoding="utf-8")
        data_db = copilot / "data.db"
        with sqlite3.connect(data_db) as db:
            db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)")
            db.execute("INSERT INTO sessions (id, title) VALUES (?, ?)", (SID, "OldDb"))
            db.commit()

        code, data = run_main(["rename", "copilot", SID, "Copilot Fresh"])
        self.assertEqual(code, 0, data)

        with sqlite3.connect(data_db) as db:
            row = db.execute("SELECT title FROM sessions WHERE id = ?", (SID,)).fetchone()
        self.assertEqual(row[0], "Copilot Fresh")
        yaml_text = (state / "workspace.yaml").read_text(encoding="utf-8")
        self.assertIn('name: "Copilot Fresh"', yaml_text)
        meta = json.loads((state / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["title"], "Copilot Fresh")
        self.assertEqual(meta["name"], "Copilot Fresh")
        # Directory name must not change
        self.assertTrue(state.is_dir())

    def test_rename_copilot_via_copilot_home_env(self) -> None:
        alt = self.home / "alt-copilot"
        state = alt / "session-state" / SID2
        state.mkdir(parents=True)
        (state / "workspace.yaml").write_text(f"id: {SID2}\n", encoding="utf-8")
        os.environ["COPILOT_HOME"] = str(alt)
        code, data = run_main(["rename", "copilot", SID2, "ViaEnv"])
        self.assertEqual(code, 0, data)
        self.assertIn('name: "ViaEnv"', (state / "workspace.yaml").read_text(encoding="utf-8"))

    # --- delete smoke (still supported for grok) ---

    def test_delete_grok(self) -> None:
        proj = self.home / ".grok" / "sessions" / "proj"
        session = proj / SID
        session.mkdir(parents=True)
        (session / "summary.json").write_text("{}", encoding="utf-8")
        code, data = run_main(["delete", "grok", SID])
        self.assertEqual(code, 0, data)
        self.assertFalse(session.exists())


if __name__ == "__main__":
    unittest.main()
