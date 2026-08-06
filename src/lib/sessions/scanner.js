#!/usr/bin/env node
// @ts-check
/**
 * List AI CLI sessions for a cwd. Prints JSON array of {id,title,updatedAt,branch,cli}.
 *
 * Usage: node scanner.js <cli> <cwd>
 *   cli: grok | claude | codex | copilot | cursor
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CODEX_ROLLOUT_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F-]{36})\.jsonl(?:\.zst)?$/;
const PER_GROUP_CAP = 25;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collapse whitespace, strip control chars, truncate to limit. */
function oneLine(value, limit = 120) {
  const text = String(value == null ? "" : value)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "\uFFFD")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 3)) + "...";
}

/** Return file mtime in milliseconds, or 0 on error. */
function mtimeMs(filePath) {
  try {
    return Math.trunc(fs.statSync(filePath).mtimeMs);
  } catch {
    return 0;
  }
}

/** Parse an ISO date string or numeric timestamp to epoch milliseconds. */
function isoToMs(value) {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value === "number") {
    const n = Math.trunc(value);
    return Math.abs(n) < 1_000_000_000_000 ? n * 1000 : n;
  }
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

/** Build a canonical session row object. */
function makeRow(cli, sid, title, updated, branch = null) {
  return {
    id: sid,
    title: oneLine(title) || "(untitled)",
    updatedAt: Math.trunc(updated) || 0,
    branch: typeof branch === "string" && branch ? branch : null,
    cli,
  };
}

/** URL-percent-encode a path (like Python's urllib.parse.quote with safe=''). */
function urlEncode(str) {
  return encodeURIComponent(str).replace(/%2F/gi, "/");
}

/** Claude-style slugify: replace non-alphanumeric with "-". */
function slugify(str) {
  return str.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Try to parse a JSON string; return undefined on failure. */
function tryJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Read up to maxBytes from a file. Returns "" on error. */
function readHead(filePath, maxBytes = 65536) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString("utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// SQLite access — try node:sqlite (Node 22.5+), fall back to none
// ---------------------------------------------------------------------------

let Database = null;
try {
  // node:sqlite is behind --experimental-sqlite in Node <23.4 and stable in 23.4+
  // We attempt to require it; if unavailable we fall through to null.
  // eslint-disable-next-line n/no-missing-require
  ({ DatabaseSync: Database } = require("node:sqlite"));
} catch {
  // SQLite not available; DB-based providers will fall back to file scanning.
}

/**
 * Open a SQLite DB in read-only mode. Returns a db object or null.
 * @param {string} dbPath
 * @returns {{ prepare: Function, close: Function } | null}
 */
function openDb(dbPath) {
  if (!Database) return null;
  try {
    return new Database(dbPath, { readonly: true, open: true });
  } catch {
    return null;
  }
}

/** Return the set of column names for a table. */
function tableColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

/** Return the set of table names in the DB. */
function tableNames(db) {
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Provider: grok
// ---------------------------------------------------------------------------

function listGrok(cwd) {
  const root = path.join(os.homedir(), ".grok", "sessions", urlEncode(cwd));
  if (!fs.existsSync(root)) return [];
  let children;
  try {
    children = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of children) {
    const childPath = path.join(root, name);
    let stat;
    try {
      stat = fs.lstatSync(childPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    if (!UUID_RE.test(name)) continue;

    let title = "(untitled)";
    let updated = mtimeMs(childPath);
    let sid = name;
    const summaryPath = path.join(childPath, "summary.json");
    if (fs.existsSync(summaryPath) && !fs.lstatSync(summaryPath).isSymbolicLink()) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      } catch {
        data = null;
      }
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const info = data.info && typeof data.info === "object" ? data.info : {};
        if (typeof info.id === "string") sid = info.id;
        title =
          data.generated_title || data.session_summary || data.agent_name || title;
        updated = isoToMs(data.updated_at || data.last_active_at) || updated;
      }
    }
    out.push(makeRow("grok", sid, title, updated, null));
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, PER_GROUP_CAP);
}

// ---------------------------------------------------------------------------
// Provider: claude
// ---------------------------------------------------------------------------

function claudeTitleFromJsonl(filePath) {
  let title = null;
  let cwd = null;
  let branch = null;
  let firstUser = null;

  let lines;
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n");
  } catch {
    return ["(untitled)", null, null];
  }

  for (let i = 0; i < Math.min(lines.length, 201); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const rec = tryJSON(line);
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;

    if (typeof rec.cwd === "string" && !cwd) cwd = rec.cwd;
    if (typeof rec.gitBranch === "string" && !branch) branch = rec.gitBranch;

    const t = rec.type;
    const recTitle = rec.title || rec.customTitle || rec.aiTitle;
    if (t === "custom-title" && typeof recTitle === "string") {
      title = recTitle;
    } else if (t === "ai-title" && typeof recTitle === "string") {
      title = title || recTitle;
    } else if (t === "summary" && typeof rec.summary === "string") {
      title = title || rec.summary;
    } else if (t === "user" && firstUser == null) {
      const msg = rec.message;
      const content =
        msg && typeof msg === "object" ? msg.content : rec.content;
      if (typeof content === "string") {
        firstUser = content;
      } else if (Array.isArray(content)) {
        const parts = [];
        for (const block of content) {
          if (block && typeof block === "object" && typeof block.text === "string")
            parts.push(block.text);
          else if (typeof block === "string") parts.push(block);
        }
        if (parts.length) firstUser = parts.join("\n");
      }
    }
  }
  return [title || firstUser || "(untitled)", cwd, branch];
}

function listClaude(cwd) {
  const configuredEnv = process.env.CLAUDE_CONFIG_DIR;
  const base = configuredEnv
    ? path.resolve(configuredEnv.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), ".claude");
  const projects = path.join(base, "projects");
  if (!fs.existsSync(projects)) return [];

  const expected = path.join(projects, slugify(cwd));
  const dirs = [];
  try {
    if (
      fs.existsSync(expected) &&
      fs.lstatSync(expected).isDirectory() &&
      !fs.lstatSync(expected).isSymbolicLink()
    ) {
      dirs.push(expected);
    }
  } catch { /* ignore */ }

  try {
    const entries = fs.readdirSync(projects).sort();
    for (const name of entries) {
      const p = path.join(projects, name);
      if (p === expected) continue;
      try {
        const st = fs.lstatSync(p);
        if (st.isDirectory() && !st.isSymbolicLink()) dirs.push(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  const out = [];
  const seen = new Set();
  for (const project of dirs) {
    let files;
    try {
      files = fs.readdirSync(project);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const stem = name.slice(0, -6);
      if (!UUID_RE.test(stem) || seen.has(stem)) continue;
      const filePath = path.join(project, name);
      try {
        const st = fs.lstatSync(filePath);
        if (st.isSymbolicLink() || !st.isFile()) continue;
      } catch {
        continue;
      }
      const [title, storedCwd, branch] = claudeTitleFromJsonl(filePath);
      if (storedCwd && path.normalize(storedCwd) !== path.normalize(cwd)) continue;
      if (!storedCwd && project !== expected) continue;
      seen.add(stem);
      out.push(makeRow("claude", stem, title, mtimeMs(filePath), branch));
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, PER_GROUP_CAP);
}

// ---------------------------------------------------------------------------
// Provider: codex
// ---------------------------------------------------------------------------

function codexHome() {
  const env = process.env.CODEX_HOME;
  if (env) return path.resolve(env.replace(/^~/, os.homedir()));
  return path.join(os.homedir(), ".codex");
}

function listCodexDb(home, cwd) {
  if (!Database) return null;
  let candidates = [];
  try {
    for (const name of fs.readdirSync(home)) {
      const m = name.match(/^state_(\d+)\.sqlite$/);
      if (!m) continue;
      const p = path.join(home, name);
      try {
        const st = fs.lstatSync(p);
        if (st.isFile() && !st.isSymbolicLink())
          candidates.push([parseInt(m[1], 10), p]);
      } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b[0] - a[0]);
  const dbPath = candidates[0][1];
  const db = openDb(dbPath);
  if (!db) return null;
  try {
    const cols = tableColumns(db, "threads");
    const required = ["id", "rollout_path", "source", "cwd", "archived"];
    if (!required.every((c) => cols.has(c))) return null;

    const updatedCol = cols.has("updated_at_ms")
      ? "updated_at_ms"
      : cols.has("updated_at")
      ? "updated_at"
      : null;
    if (!updatedCol) return null;

    const titleCol = cols.has("title") ? "title" : "''";
    const firstCol = cols.has("first_user_message") ? "first_user_message" : "''";
    const branchCol = cols.has("git_branch") ? "git_branch" : "NULL";

    const rows = db
      .prepare(
        `SELECT id, ${updatedCol}, ${titleCol}, ${firstCol}, ${branchCol} ` +
          `FROM threads WHERE archived = 0 AND cwd = ? ` +
          `AND source IN ('cli', 'vscode') ` +
          `ORDER BY ${updatedCol} DESC LIMIT ?`,
      )
      .all(cwd, PER_GROUP_CAP);

    const out = [];
    for (const r of rows) {
      const [sid, rawUpdated, rawTitle, firstUser, git] = r;
      if (typeof sid !== "string" || !UUID_RE.test(sid)) continue;
      const title =
        typeof rawTitle === "string" && rawTitle.trim() ? rawTitle : firstUser;
      const updated = isoToMs(rawUpdated) || 0;
      out.push(
        makeRow(
          "codex",
          sid,
          title ? String(title) : "(untitled)",
          updated,
          typeof git === "string" ? git : null,
        ),
      );
    }
    return out;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch { /* ignore */ }
  }
}

function listCodexFiles(home, cwd) {
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return [];
  const out = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (name.endsWith(".zst")) continue;
      const m = name.match(CODEX_ROLLOUT_RE);
      if (!m) continue;

      const head = readHead(full, 65000);
      let payload = null;
      for (const line of head.split("\n").slice(0, 20)) {
        const rec = tryJSON(line.trim());
        if (
          rec &&
          typeof rec === "object" &&
          rec.type === "session_meta" &&
          rec.payload &&
          typeof rec.payload === "object"
        ) {
          payload = rec.payload;
          break;
        }
      }
      if (!payload || payload.cwd !== cwd) continue;
      if (
        payload.source !== undefined &&
        payload.source !== null &&
        payload.source !== "cli" &&
        payload.source !== "vscode"
      )
        continue;
      const sid = payload.id || m[1];
      if (typeof sid !== "string" || !UUID_RE.test(sid)) continue;
      let branch = null;
      if (
        payload.git &&
        typeof payload.git === "object" &&
        typeof payload.git.branch === "string"
      ) {
        branch = payload.git.branch;
      }
      out.push(makeRow("codex", sid, "(untitled)", mtimeMs(full), branch));
    }
  }

  walk(root);
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, PER_GROUP_CAP);
}

function listCodex(cwd) {
  const home = codexHome();
  const dbRows = listCodexDb(home, cwd);
  if (dbRows !== null) return dbRows;
  return listCodexFiles(home, cwd);
}

// ---------------------------------------------------------------------------
// Provider: copilot
// ---------------------------------------------------------------------------

function listCopilot(cwd) {
  const homeEnv = process.env.COPILOT_HOME;
  const home = homeEnv
    ? path.resolve(homeEnv.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), ".copilot");
  const out = [];
  let warnedUnfiltered = false;

  const dbPath = path.join(home, "session-store.db");
  if (Database && fs.existsSync(dbPath) && !fs.lstatSync(dbPath).isSymbolicLink()) {
    const db = openDb(dbPath);
    if (db) {
      try {
        const tables = tableNames(db);
        for (const table of ["sessions", "session", "session_docs", "chronicle"]) {
          if (!tables.has(table)) continue;
          const cols = tableColumns(db, table);

          const idCol = ["id", "session_id", "sessionId"].find((c) => cols.has(c));
          if (!idCol) continue;
          const titleCol =
            ["title", "name", "summary"].find((c) => cols.has(c)) || null;
          const updatedCol =
            [
              "updated_at",
              "updatedAt",
              "updated_at_ms",
              "mtime",
              "last_active_at",
            ].find((c) => cols.has(c)) || null;
          const pathCol =
            ["cwd", "workspace", "workspace_path", "workspacePath", "path"].find(
              (c) => cols.has(c),
            ) || null;

          const selectCols = [
            idCol,
            titleCol || "NULL",
            updatedCol || "NULL",
            pathCol || "NULL",
          ];
          const rows = db
            .prepare(`SELECT ${selectCols.join(", ")} FROM ${table} LIMIT 200`)
            .all();

          for (const r of rows) {
            const [sid, title, updated, pathVal] = r;
            if (typeof sid !== "string" || !sid) continue;
            if (pathVal !== null && typeof pathVal === "string") {
              if (
                path.normalize(pathVal) !== path.normalize(cwd) &&
                !pathVal.includes(cwd)
              )
                continue;
            } else if (!pathCol) {
              warnedUnfiltered = true;
            }
            out.push(
              makeRow(
                "copilot",
                sid,
                title ? String(title) : "(untitled)",
                isoToMs(updated) || 0,
                null,
              ),
            );
          }
          if (out.length) break;
        }
      } catch { /* ignore */ } finally {
        try {
          db.close();
        } catch { /* ignore */ }
      }
    }
  }

  const state = path.join(home, "session-state");
  if (fs.existsSync(state) && out.length < PER_GROUP_CAP) {
    let children;
    try {
      children = fs.readdirSync(state);
    } catch {
      children = [];
    }
    const seen = new Set(out.map((r) => r.id));
    for (const name of children) {
      const childPath = path.join(state, name);
      let st;
      try {
        st = fs.lstatSync(childPath);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.isSymbolicLink() || seen.has(name)) continue;

      const wsPath = path.join(childPath, "workspace.yaml");
      let match = true;
      if (fs.existsSync(wsPath) && !fs.lstatSync(wsPath).isSymbolicLink()) {
        let text = "";
        try {
          text = fs.readFileSync(wsPath, "utf8");
        } catch { /* ignore */ }
        if (!text.includes(cwd) && !text.includes(path.normalize(cwd)))
          match = false;
      } else {
        match = true;
        warnedUnfiltered = true;
      }
      if (!match) continue;

      let title = name;
      const metaPath = path.join(childPath, "meta.json");
      if (fs.existsSync(metaPath) && !fs.lstatSync(metaPath).isSymbolicLink()) {
        try {
          const data = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          if (data && typeof data === "object")
            title = data.name || data.title || title;
        } catch { /* ignore */ }
      }
      out.push(makeRow("copilot", name, String(title), mtimeMs(childPath), null));
    }
  }

  if (warnedUnfiltered && out.length) {
    for (const r of out) {
      if (!String(r.title).startsWith("[unfiltered]"))
        r.title = `[unfiltered] ${r.title}`;
    }
  }

  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, PER_GROUP_CAP);
}

// ---------------------------------------------------------------------------
// Provider: cursor
// ---------------------------------------------------------------------------

function listCursor(cwd) {
  const hash = crypto.createHash("md5").update(cwd, "utf8").digest("hex");
  const root = path.join(os.homedir(), ".cursor", "chats", hash);
  if (!fs.existsSync(root)) return [];
  let children;
  try {
    children = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of children) {
    const childPath = path.join(root, name);
    let st;
    try {
      st = fs.lstatSync(childPath);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;

    let title = "(untitled)";
    let updated = mtimeMs(childPath);
    let branch = null;
    const metaPath = path.join(childPath, "meta.json");
    if (fs.existsSync(metaPath) && !fs.lstatSync(metaPath).isSymbolicLink()) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch {
        data = null;
      }
      if (data && typeof data === "object") {
        title = data.title || data.name || title;
        updated =
          isoToMs(data.updatedAtMs || data.updatedAt || data.updated_at) ||
          updated;
        if (typeof data.branch === "string") branch = data.branch;
      }
    }
    out.push(makeRow("cursor", name, String(title), updated, branch));
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, PER_GROUP_CAP);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    process.stdout.write("[]\n");
    process.exit(2);
  }
  const cli = args[0].trim().toLowerCase();
  const cwd = args[1];
  try {
    let sessions;
    if (cli === "grok") sessions = listGrok(cwd);
    else if (cli === "claude") sessions = listClaude(cwd);
    else if (cli === "codex") sessions = listCodex(cwd);
    else if (cli === "copilot") sessions = listCopilot(cwd);
    else if (cli === "cursor") sessions = listCursor(cwd);
    else {
      process.stdout.write(JSON.stringify({ error: `unknown cli: ${cli}` }) + "\n");
      process.exit(2);
    }
    process.stdout.write(JSON.stringify(sessions) + "\n");
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err?.message || err) }) + "\n");
    process.exit(1);
  }
}

main();
