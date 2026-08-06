import { joinPath, sqlQuote } from "../../host-fs.js";
import {
  UUID_RE,
  CODEX_ROLLOUT_RE,
  PER_GROUP_CAP,
  isoToMs,
  sessionRow,
  toPromise,
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
      const home = await toPromise(fs.homeDir());
      return joinPath(home, envHome.slice(1).replace(/^\//, ""));
    }
    return envHome;
  }
  return joinPath(await toPromise(fs.homeDir()), ".codex");
}

/**
 * @param {*} fs
 * @param {string} home
 * @param {string} cwd
 * @returns {Promise<Array|null>}
 */
async function listCodexDb(fs, home, cwd) {
  let names;
  try {
    names = await toPromise(fs.listDir(home));
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    const m = /^state_(\d+)\.sqlite$/.exec(name);
    if (!m) continue;
    const path = joinPath(home, name);
    if (await toPromise(fs.isFile(path))) {
      candidates.push({ n: Number(m[1]), path });
    }
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
 * JSONL rollout fallback (skip .zst).
 * @param {*} fs
 * @param {string} home
 * @param {string} cwd
 */
async function listCodexFiles(fs, home, cwd) {
  const root = joinPath(home, "sessions");
  if (!(await toPromise(fs.isDir(root)))) return [];

  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = await toPromise(fs.listDir(dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = joinPath(dir, name);
      if (await toPromise(fs.isDir(path))) {
        stack.push(path);
        continue;
      }
      if (name.endsWith(".zst")) continue;
      const m = CODEX_ROLLOUT_RE.exec(name);
      if (!m) continue;
      if (!(await toPromise(fs.isFile(path)))) continue;

      let head;
      try {
        head = await toPromise(fs.readHead(path, { maxBytes: 64_000 }));
      } catch {
        continue;
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
      if (!payload || payload.cwd !== cwd) continue;
      if (
        payload.source != null &&
        payload.source !== "cli" &&
        payload.source !== "vscode"
      ) {
        continue;
      }
      const sid = payload.id || m[1];
      if (typeof sid !== "string" || !UUID_RE.test(sid)) continue;
      let branch = null;
      if (payload.git && typeof payload.git === "object" && typeof payload.git.branch === "string") {
        branch = payload.git.branch;
      }
      const updated = await toPromise(fs.mtimeMs(path));
      out.push(sessionRow("codex", sid, "(untitled)", updated, branch));
    }
  }
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
