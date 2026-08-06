#!/usr/bin/env python3
"""Unit tests for Copilot resume evidence filtering in scanner.list_copilot."""
from __future__ import annotations

import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCANNER_PATH = ROOT / "src" / "lib" / "sessions" / "scanner.py"


def load_scanner():
    spec = importlib.util.spec_from_file_location("session_scanner", SCANNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


sc = load_scanner()

PROJ = "/tmp/muxy-test-proj"
OTHER = "/tmp/muxy-other-proj"
GOOD_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
EMPTY_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
OTHER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
TURNS_ONLY_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd"
DB_TITLE_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"


class ListCopilotTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self.state = self.home / "session-state"
        self.state.mkdir()
        self._old_home = sc.os.environ.get("COPILOT_HOME")
        sc.os.environ["COPILOT_HOME"] = str(self.home)

    def tearDown(self) -> None:
        if self._old_home is None:
            sc.os.environ.pop("COPILOT_HOME", None)
        else:
            sc.os.environ["COPILOT_HOME"] = self._old_home
        self._tmp.cleanup()

    def _session_dir(
        self,
        sid: str,
        *,
        cwd: str | None = PROJ,
        branch: str = "main",
        name: str | None = None,
        events: str | None = None,
    ) -> Path:
        d = self.state / sid
        d.mkdir(parents=True, exist_ok=True)
        (d / "files").mkdir(exist_ok=True)
        lines = [f"id: {sid}"]
        if cwd is not None:
            lines.append(f"cwd: {cwd}")
        if branch:
            lines.append(f"branch: {branch}")
        if name:
            lines.append(f"name: {name}")
        (d / "workspace.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")
        if events is not None:
            (d / "events.jsonl").write_text(events, encoding="utf-8")
        return d

    def _write_store(
        self,
        *,
        sessions: list[tuple[str, str | None, str | None]] | None = None,
        turns: list[str] | None = None,
        data_titles: dict[str, str] | None = None,
    ) -> None:
        store = self.home / "session-store.db"
        with sqlite3.connect(store) as db:
            db.executescript(
                """
                CREATE TABLE sessions (
                  id TEXT PRIMARY KEY,
                  cwd TEXT,
                  branch TEXT,
                  summary TEXT,
                  updated_at TEXT
                );
                CREATE TABLE turns (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  session_id TEXT,
                  turn_index INT,
                  user_message TEXT
                );
                """
            )
            for sid, cwd, summary in sessions or []:
                db.execute(
                    "INSERT INTO sessions (id, cwd, branch, summary, updated_at) "
                    "VALUES (?, ?, 'main', ?, '2026-08-06T12:00:00Z')",
                    (sid, cwd, summary),
                )
            for i, sid in enumerate(turns or []):
                db.execute(
                    "INSERT INTO turns (session_id, turn_index, user_message) "
                    "VALUES (?, ?, ?)",
                    (sid, i, "hello"),
                )
        if data_titles:
            data = self.home / "data.db"
            with sqlite3.connect(data) as db:
                db.executescript(
                    """
                    CREATE TABLE sessions (
                      id TEXT PRIMARY KEY,
                      title TEXT,
                      updated_at TEXT
                    );
                    """
                )
                for sid, title in data_titles.items():
                    db.execute(
                        "INSERT INTO sessions (id, title, updated_at) "
                        "VALUES (?, ?, '2026-08-06T12:00:00Z')",
                        (sid, title),
                    )

    def _ids(self, rows: list[dict]) -> set[str]:
        return {r["id"] for r in rows}

    def test_events_nonempty_cwd_match_listed(self) -> None:
        self._session_dir(
            GOOD_ID,
            events='{"type":"user.message","data":{"content":"Fix the scanner"}}\n',
            name="Weak",
        )
        self._write_store(sessions=[(GOOD_ID, PROJ, "DB Title From Summary")])
        rows = sc.list_copilot(PROJ)
        self.assertIn(GOOD_ID, self._ids(rows))

    def test_turns_only_listed(self) -> None:
        self._session_dir(TURNS_ONLY_ID, cwd=PROJ)
        self._write_store(
            sessions=[(TURNS_ONLY_ID, PROJ, "Turns only session")],
            turns=[TURNS_ONLY_ID],
        )
        rows = sc.list_copilot(PROJ)
        self.assertIn(TURNS_ONLY_ID, self._ids(rows))

    def test_empty_shell_omitted(self) -> None:
        self._session_dir(EMPTY_ID, cwd=PROJ)
        self._write_store(sessions=[(EMPTY_ID, PROJ, None)])
        rows = sc.list_copilot(PROJ)
        self.assertNotIn(EMPTY_ID, self._ids(rows))

    def test_optimistic_chat_omitted(self) -> None:
        sid = "optimistic-chat-e4b462a3-3628-4aad-90ae-43b9c4fee922"
        self._session_dir(
            sid,
            cwd=PROJ,
            events='{"type":"user.message","data":{"content":"x"}}\n',
        )
        self.assertTrue(sc.is_copilot_stub_id(sid))
        rows = sc.list_copilot(PROJ)
        self.assertNotIn(sid, self._ids(rows))

    def test_pending_session_prefix_stub(self) -> None:
        self.assertTrue(sc.is_copilot_stub_id("pending-session:draft:abc"))
        self.assertTrue(sc.is_copilot_stub_id("pending-session-xyz"))

    def test_missing_cwd_omitted(self) -> None:
        self._session_dir(
            GOOD_ID,
            cwd=None,
            events='{"type":"user.message","data":{"content":"hi"}}\n',
        )
        rows = sc.list_copilot(PROJ)
        self.assertNotIn(GOOD_ID, self._ids(rows))

    def test_other_cwd_omitted(self) -> None:
        self._session_dir(
            OTHER_ID,
            cwd=OTHER,
            events='{"type":"user.message","data":{"content":"other"}}\n',
        )
        rows = sc.list_copilot(PROJ)
        self.assertNotIn(OTHER_ID, self._ids(rows))

    def test_db_title_wins_when_strong(self) -> None:
        self._session_dir(
            DB_TITLE_ID,
            cwd=PROJ,
            name="Yaml Name",
            events='{"type":"user.message","data":{"content":"first user line"}}\n',
        )
        self._write_store(
            sessions=[(DB_TITLE_ID, PROJ, "Store Summary Title")],
            turns=[DB_TITLE_ID],
            data_titles={DB_TITLE_ID: "Desktop DB Title"},
        )
        rows = sc.list_copilot(PROJ)
        hit = next(r for r in rows if r["id"] == DB_TITLE_ID)
        self.assertEqual(hit["title"], "Desktop DB Title")

    def test_db_only_without_evidence_omitted(self) -> None:
        data = self.home / "data.db"
        with sqlite3.connect(data) as db:
            db.executescript(
                """
                CREATE TABLE sessions (id TEXT, title TEXT, updated_at TEXT);
                CREATE TABLE workspaces (session_id TEXT, cwd TEXT, branch TEXT);
                """
            )
            db.execute(
                "INSERT INTO sessions VALUES (?, 'Orphan', '2026-08-06T12:00:00Z')",
                (GOOD_ID,),
            )
            db.execute(
                "INSERT INTO workspaces VALUES (?, ?, 'main')",
                (GOOD_ID, PROJ),
            )
        rows = sc.list_copilot(PROJ)
        self.assertEqual(rows, [])

    def test_helpers(self) -> None:
        p = self.home / "e.jsonl"
        p.write_text("x", encoding="utf-8")
        self.assertTrue(sc.events_nonempty(p))
        empty = self.home / "empty.jsonl"
        empty.write_text("", encoding="utf-8")
        self.assertFalse(sc.events_nonempty(empty))
        self.assertFalse(sc.is_copilot_stub_id(GOOD_ID))
        self.assertTrue(sc.is_copilot_stub_id("optimistic-chat-1"))


if __name__ == "__main__":
    unittest.main()
