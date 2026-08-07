import { joinPath, sqlQuote } from "../../host-fs.js";
import {
  UUID_RE,
  CODEX_ROLLOUT_RE,
  PER_GROUP_CAP,
  ENRICH_SLACK,
  SCAN_CONCURRENCY,
  CODEX_MAX_DIRS_WALKED,
  isoToMs,
  sessionRow,
  toPromise,
  mapPool,
} from "./helpers.js";

/**
 * @param {*} fs
 * @param {{ home?: string, codexHome?: string | null }} [opts]
 */
async function resolveCodexHome(fs, opts = {}) {
  if (opts.codexHome) return opts.codexHome;
  const envHome = await toPromise(fs.env("CODEX_HOME"));
  if (envHome) {
    if (envHome.startsWith("~")) {
      const home = opts.home ?? (await toPromise(fs.homeDir()));
      return joinPath(home, envHome.slice(1).replace(/^\//, ""));
    }
    return envHome;
  }
  return joinPath(opts.home ?? (await toPromise(fs.homeDir())), ".codex");
}

/**
 * @param {*} fs
 * @param {string} home
 * @param {string} cwd
 * @returns {Promise<Array|null>}
 */
async function listCodexDb(fs, home, cwd) {
  let entries;
  try {
    entries = await toPromise(fs.listDirDetailed(home));
  } catch {
    return null;
  }
  const candidates = [];
  for (const e of entries) {
    if (e.kind !== "file") continue;
    const m = /^state_(\d+)\.sqlite$/.exec(e.name);
    if (!m) continue;
    candidates.push({ n: Number(m[1]), path: joinPath(home, e.name) });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.n - a.n);
  const dbPath = candidates[0].path;

  let cols;
  try {
    cols = await toPromise(fs.sqliteTableColumns(dbPath, "threads"));
  } catch {
    return null;
  }
  const required = ["id", "source", "cwd"];
  if (!required.every((c) => cols.has(c))) return null;

  let updatedCol = null;
  if (cols.has("updated_at_ms")) updatedCol = "updated_at_ms";
  else if (cols.has("updated_at")) updatedCol = "updated_at";
  if (!updatedCol) return null;

  const titleCol = cols.has("title") ? "title" : "''";
  const firstCol = cols.has("first_user_message") ? "first_user_message" : "''";
  const branchCol = cols.has("git_branch") ? "git_branch" : "NULL";

  const sql =
    `SELECT id, ${updatedCol} AS updated, ${titleCol} AS title, ` +
    `${firstCol} AS first_user, ${branchCol} AS git_branch ` +
    `FROM threads WHERE cwd = ${sqlQuote(cwd)} ` +
    `AND source IN ('cli', 'vscode') ` +
    `ORDER BY ${updatedCol} DESC LIMIT ${PER_GROUP_CAP}`;

  let rows;
  try {
    rows = await toPromise(fs.sqliteQuery(dbPath, sql));
  } catch {
    return null;
  }

  const out = [];
  for (const r of rows) {
    const sid = r.id;
    if (typeof sid !== "string" || !UUID_RE.test(sid)) continue;
    const rawTitle = r.title;
    const firstUser = r.first_user;
    const title =
      typeof rawTitle === "string" && rawTitle.trim()
        ? rawTitle
        : firstUser;
    const updated = isoToMs(r.updated) || 0;
    const git = typeof r.git_branch === "string" ? r.git_branch : null;
    out.push(
      sessionRow(
        "codex",
        sid,
        title ? String(title) : "(untitled)",
        updated,
        git,
      ),
    );
  }
  return out;
}

/**
 * JSONL rollout fallback (skip .zst). Bounded walk + mtime-ranked reads.
 * @param {*} fs
 * @param {string} home
 * @param {string} cwd
 */
async function listCodexFiles(fs, home, cwd) {
  const root = joinPath(home, "sessions");
  if (!(await toPromise(fs.isDir(root)))) return [];

  /** @type {Array<{ path: string, sidFromName: string, mtimeMs: number }>} */
  const fileCandidates = [];
  const stack = [root];
  let dirsWalked = 0;

  while (stack.length && dirsWalked < CODEX_MAX_DIRS_WALKED) {
    const dir = stack.pop();
    dirsWalked++;
    let entries;
    try {
      entries = await toPromise(fs.listDirDetailed(dir));
    } catch {
      continue;
    }
    for (const e of entries) {
      const path = joinPath(dir, e.name);
      if (e.kind === "dir") {
        stack.push(path);
        continue;
      }
      if (e.kind !== "file") continue;
      if (e.name.endsWith(".zst")) continue;
      const m = CODEX_ROLLOUT_RE.exec(e.name);
      if (!m) continue;
      fileCandidates.push({
        path,
        sidFromName: m[1],
        mtimeMs: e.mtimeMs || 0,
      });
    }
  }

  fileCandidates.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  const toRead = fileCandidates.slice(0, PER_GROUP_CAP + ENRICH_SLACK);

  const rows = await mapPool(toRead, SCAN_CONCURRENCY, async (c) => {
    let head;
    try {
      head = await toPromise(fs.readHead(c.path, { maxBytes: 64_000 }));
    } catch {
      return null;
    }
    let payload = null;
    for (const line of head.split("\n").slice(0, 20)) {
      try {
        const rec = JSON.parse(line);
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
      } catch {
        /* continue */
      }
    }
    if (!payload || payload.cwd !== cwd) return null;
    if (
      payload.source != null &&
      payload.source !== "cli" &&
      payload.source !== "vscode"
    ) {
      return null;
    }
    const sid = payload.id || c.sidFromName;
    if (typeof sid !== "string" || !UUID_RE.test(sid)) return null;
    let branch = null;
    if (payload.git && typeof payload.git === "object" && typeof payload.git.branch === "string") {
      branch = payload.git.branch;
    }
    return sessionRow("codex", sid, "(untitled)", c.mtimeMs || 0, branch);
  });

  const out = rows.filter(Boolean);
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, PER_GROUP_CAP);
}

/**
 * @param {*} fs
 * @param {string} cwd
 * @param {{ home?: string, codexHome?: string | null, sqliteAvailable?: boolean }} [opts]
 */
export async function listCodex(fs, cwd, opts = {}) {
  const home = await resolveCodexHome(fs, opts);
  if (opts.sqliteAvailable === false) {
    return listCodexFiles(fs, home, cwd);
  }
  const dbRows = await listCodexDb(fs, home, cwd);
  if (dbRows != null) return dbRows;
  return listCodexFiles(fs, home, cwd);
}

export { resolveCodexHome };
