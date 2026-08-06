import { joinPath, sqlQuote } from "../../host-fs.js";
import {
  PER_GROUP_CAP,
  normPath,
  sessionRow,
  toPromise,
  isoToMs,
} from "./helpers.js";

const SES_ID_RE = /^ses_[0-9a-zA-Z._-]{4,120}$/;

/**
 * Resolve OpenCode data directory (XDG_DATA_HOME/opencode or ~/.local/share/opencode).
 * @param {*} fs
 * @param {{ home?: string, dataDir?: string }} [opts]
 */
export async function resolveOpenCodeDataDir(fs, opts = {}) {
  if (opts.dataDir) return opts.dataDir;
  const xdg = await toPromise(fs.env("XDG_DATA_HOME"));
  if (xdg) return joinPath(xdg, "opencode");
  const home = opts.home ?? (await toPromise(fs.homeDir()));
  return joinPath(home, ".local", "share", "opencode");
}

/**
 * Pick the channel DB under the data dir (prefer opencode.db).
 * @param {*} fs
 * @param {string} dataDir
 * @param {string | null} [openCodeDbEnv]
 */
export async function resolveOpenCodeDbPath(fs, dataDir, openCodeDbEnv = null) {
  if (openCodeDbEnv) {
    if (openCodeDbEnv === ":memory:") return null;
    if (openCodeDbEnv.startsWith("/")) return openCodeDbEnv;
    return joinPath(dataDir, openCodeDbEnv);
  }
  const primary = joinPath(dataDir, "opencode.db");
  if (await toPromise(fs.isFile(primary))) return primary;

  // Channel builds: opencode-<channel>.db
  let names = [];
  try {
    names = await toPromise(fs.listDir(dataDir));
  } catch {
    return null;
  }
  const candidates = names
    .filter((n) => /^opencode(-[A-Za-z0-9._-]+)?\.db$/.test(n))
    .map((n) => joinPath(dataDir, n));
  for (const path of candidates) {
    if (await toPromise(fs.isFile(path))) return path;
  }
  return null;
}

/**
 * List OpenCode sessions for cwd from opencode.db.
 * @param {*} fs
 * @param {string} cwd
 * @param {{ home?: string, dataDir?: string, dbPath?: string, sqliteAvailable?: boolean }} [opts]
 */
export async function listOpenCode(fs, cwd, opts = {}) {
  if (opts.sqliteAvailable === false) {
    throw new Error(
      "opencode: /usr/bin/sqlite3 is required to read session stores on this host",
    );
  }

  const dataDir = await resolveOpenCodeDataDir(fs, opts);
  let dbPath = opts.dbPath;
  if (!dbPath) {
    const envDb = await toPromise(fs.env("OPENCODE_DB"));
    dbPath = await resolveOpenCodeDbPath(fs, dataDir, envDb);
  }
  if (!dbPath) return [];

  // Roots only (no child sessions), not archived, ordered by updated.
  // Filter cwd in JS with normPath (DB may store trailing slash variants).
  const sql =
    `SELECT id, title, directory, time_updated, time_archived, parent_id ` +
    `FROM session ` +
    `WHERE (parent_id IS NULL OR parent_id = '') ` +
    `AND (time_archived IS NULL) ` +
    `ORDER BY time_updated DESC LIMIT 200`;

  let rows;
  try {
    rows = await toPromise(fs.sqliteQuery(dbPath, sql));
  } catch (err) {
    // Missing table / empty DB → no sessions rather than hard fail
    const msg = String(err?.message || err);
    if (/no such table|unable to open/i.test(msg)) return [];
    throw err;
  }

  const target = normPath(cwd);
  const out = [];
  for (const r of rows) {
    const sid = r.id;
    if (typeof sid !== "string" || !SES_ID_RE.test(sid)) continue;
    const dir = typeof r.directory === "string" ? r.directory : "";
    if (!dir || normPath(dir) !== target) continue;
    const title =
      typeof r.title === "string" && r.title.trim() ? r.title : "(untitled)";
    let updated = 0;
    if (typeof r.time_updated === "number") {
      updated = isoToMs(r.time_updated) || Math.trunc(r.time_updated) || 0;
    } else if (r.time_updated != null) {
      updated = isoToMs(r.time_updated) || 0;
    }
    out.push(sessionRow("opencode", sid, title, updated, null, dir));
    if (out.length >= PER_GROUP_CAP) break;
  }
  return out;
}
