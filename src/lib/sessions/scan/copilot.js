import { joinPath, sqlQuote } from "../../host-fs.js";
import { isSafeSessionId, isCopilotStubId } from "../../sanitize.js";
import {
  PER_GROUP_CAP,
  isoToMs,
  sessionRow,
  parseSimpleYaml,
  pathMatchesCwd,
  firstUserMessageFromEvents,
  pickDisplayTitle,
  toPromise,
  mapPool,
} from "./helpers.js";

/**
 * @param {*} fs
 * @param {{ home?: string, copilotHome?: string | null }} [opts]
 */
async function resolveCopilotHome(fs, opts = {}) {
  if (opts.copilotHome) return opts.copilotHome;
  const envHome = await toPromise(fs.env("COPILOT_HOME"));
  if (envHome) {
    if (envHome.startsWith("~")) {
      const home = await toPromise(fs.homeDir());
      return joinPath(home, envHome.slice(1).replace(/^\//, ""));
    }
    return envHome;
  }
  return joinPath(await toPromise(fs.homeDir()), ".copilot");
}

/**
 * Session ids with at least one turn row.
 * @param {*} fs
 * @param {string} home
 * @returns {Promise<Set<string>>}
 */
async function loadCopilotTurnIds(fs, home) {
  const found = new Set();
  for (const dbName of ["session-store.db", "data.db"]) {
    const dbPath = joinPath(home, dbName);
    if (!(await toPromise(fs.isFile(dbPath)))) continue;
    try {
      const tables = await toPromise(fs.sqliteTables(dbPath));
      if (!tables.has("turns")) continue;
      const cols = await toPromise(fs.sqliteTableColumns(dbPath, "turns"));
      const sidCol = ["session_id", "sessionId", "id"].find((c) => cols.has(c));
      if (!sidCol) continue;
      const rows = await toPromise(
        fs.sqliteQuery(
          dbPath,
          `SELECT DISTINCT ${sidCol} AS sid FROM turns WHERE ${sidCol} IS NOT NULL`,
        ),
      );
      for (const r of rows) {
        if (typeof r.sid === "string" && r.sid) found.add(r.sid);
      }
    } catch {
      continue;
    }
  }
  return found;
}

function mergeCopilotSession(store, sid, fields) {
  if (!isSafeSessionId(sid)) return;
  const entry = store[sid] ?? {
    db_title: null,
    yaml_name: null,
    meta_title: null,
    first_user: null,
    cwd: null,
    branch: null,
    updated: 0,
    resumable: false,
  };
  if (fields.db_title != null && entry.db_title == null) entry.db_title = fields.db_title;
  if (fields.yaml_name != null && entry.yaml_name == null) entry.yaml_name = fields.yaml_name;
  if (fields.meta_title != null && entry.meta_title == null) {
    entry.meta_title = fields.meta_title;
  }
  if (fields.first_user != null && entry.first_user == null) {
    entry.first_user = fields.first_user;
  }
  if (fields.cwd_val && !entry.cwd) entry.cwd = fields.cwd_val;
  if (fields.branch && !entry.branch) entry.branch = fields.branch;
  if (fields.updated && fields.updated > (entry.updated || 0)) {
    entry.updated = fields.updated;
  }
  if (fields.resumable) entry.resumable = true;
  store[sid] = entry;
}

/**
 * Enrich titles from data.db / session-store.db for already-resumable sessions.
 * @param {*} fs
 * @param {string} home
 * @param {Record<string, any>} store
 */
async function readCopilotDataDb(fs, home, store) {
  for (const dbName of ["data.db", "session-store.db"]) {
    const dbPath = joinPath(home, dbName);
    if (!(await toPromise(fs.isFile(dbPath)))) continue;
    try {
      const tables = await toPromise(fs.sqliteTables(dbPath));
      if (tables.has("sessions")) {
        const scols = await toPromise(fs.sqliteTableColumns(dbPath, "sessions"));
        if (scols.has("id")) {
          const titleExpr = ["title", "summary", "name"].find((c) => scols.has(c)) || "NULL";
          const updatedExpr =
            ["updated_at", "updatedAt", "updated_at_ms", "last_active_at", "created_at"].find(
              (c) => scols.has(c),
            ) || "NULL";
          const sessPathCol = [
            "cwd",
            "path",
            "workspace_path",
            "workspacePath",
            "directory",
          ].find((c) => scols.has(c));
          const sessBranchCol = ["branch", "git_branch"].find((c) => scols.has(c));

          /** @type {Record<string, [string|null, string|null]>} */
          const wsBySid = {};
          if (tables.has("workspaces")) {
            const wcols = await toPromise(fs.sqliteTableColumns(dbPath, "workspaces"));
            const sidCol = ["session_id", "sessionId", "id"].find((c) => wcols.has(c));
            const pathCol = [
              "cwd",
              "path",
              "workspace_path",
              "workspacePath",
              "directory",
            ].find((c) => wcols.has(c));
            const branchCol = ["branch", "git_branch"].find((c) => wcols.has(c));
            if (sidCol) {
              const sel = [
                `${sidCol} AS sid`,
                pathCol ? `${pathCol} AS wpath` : "NULL AS wpath",
                branchCol ? `${branchCol} AS wbranch` : "NULL AS wbranch",
              ];
              const wrows = await toPromise(
                fs.sqliteQuery(
                  dbPath,
                  `SELECT ${sel.join(", ")} FROM workspaces LIMIT 500`,
                ),
              );
              for (const w of wrows) {
                if (typeof w.sid === "string") {
                  wsBySid[w.sid] = [
                    typeof w.wpath === "string" ? w.wpath : null,
                    typeof w.wbranch === "string" ? w.wbranch : null,
                  ];
                }
              }
            }
          }

          const sql =
            `SELECT id AS sid, ${titleExpr} AS title, ${updatedExpr} AS updated, ` +
            `${sessPathCol ? `${sessPathCol} AS sess_path` : "NULL AS sess_path"}, ` +
            `${sessBranchCol ? `${sessBranchCol} AS sess_branch` : "NULL AS sess_branch"} ` +
            `FROM sessions ORDER BY rowid DESC LIMIT 300`;
          const srows = await toPromise(fs.sqliteQuery(dbPath, sql));
          for (const row of srows) {
            const sid = row.sid;
            if (typeof sid !== "string" || !(sid in store)) continue;
            const [wpath, wbranch] = wsBySid[sid] || [null, null];
            const pathVal =
              wpath || (typeof row.sess_path === "string" ? row.sess_path : null);
            const branchVal =
              wbranch ||
              (typeof row.sess_branch === "string" ? row.sess_branch : null);
            mergeCopilotSession(store, sid, {
              db_title: row.title,
              cwd_val: pathVal,
              branch: branchVal,
              updated: isoToMs(row.updated) || 0,
              resumable: false,
            });
          }
          continue;
        }
      }

      for (const table of ["session", "session_docs", "chronicle", "sessions"]) {
        if (!tables.has(table)) continue;
        const cols = await toPromise(fs.sqliteTableColumns(dbPath, table));
        const idCol = ["id", "session_id", "sessionId"].find((c) => cols.has(c));
        if (!idCol) continue;
        const titleCol = ["title", "name", "summary"].find((c) => cols.has(c));
        const updatedCol = [
          "updated_at",
          "updatedAt",
          "updated_at_ms",
          "mtime",
          "last_active_at",
        ].find((c) => cols.has(c));
        const pathCol = [
          "cwd",
          "workspace",
          "workspace_path",
          "workspacePath",
          "path",
        ].find((c) => cols.has(c));
        const sql =
          `SELECT ${idCol} AS sid, ` +
          `${titleCol ? `${titleCol} AS title` : "NULL AS title"}, ` +
          `${updatedCol ? `${updatedCol} AS updated` : "NULL AS updated"}, ` +
          `${pathCol ? `${pathCol} AS path_val` : "NULL AS path_val"} ` +
          `FROM ${table} ORDER BY rowid DESC LIMIT 200`;
        const rows = await toPromise(fs.sqliteQuery(dbPath, sql));
        for (const row of rows) {
          if (typeof row.sid !== "string" || !row.sid || !(row.sid in store)) continue;
          mergeCopilotSession(store, row.sid, {
            db_title: row.title,
            cwd_val: typeof row.path_val === "string" ? row.path_val : null,
            updated: isoToMs(row.updated) || 0,
            resumable: false,
          });
        }
      }
    } catch {
      continue;
    }
  }
}

/**
 * List CLI-resumable Copilot sessions.
 * @param {*} fs
 * @param {string} cwd
 * @param {{ home?: string, copilotHome?: string | null, sqliteAvailable?: boolean }} [opts]
 */
export async function listCopilot(fs, cwd, opts = {}) {
  const home = await resolveCopilotHome(fs, opts);
  /** @type {Record<string, any>} */
  const store = {};

  let turnIds = new Set();
  if (opts.sqliteAvailable !== false) {
    try {
      turnIds = await loadCopilotTurnIds(fs, home);
    } catch {
      turnIds = new Set();
    }
  }

  const state = joinPath(home, "session-state");
  if (await toPromise(fs.isDir(state))) {
    let children;
    try {
      children = await toPromise(fs.listDir(state));
    } catch {
      children = [];
    }

    await mapPool(children, 16, async (name) => {
      const child = joinPath(state, name);
      if (!(await toPromise(fs.isDir(child)))) return;
      const sid = name;
      if (!isSafeSessionId(sid) || isCopilotStubId(sid)) return;

      let sessionCwd = null;
      let branch = null;
      let yamlName = null;
      const wsPath = joinPath(child, "workspace.yaml");
      if (await toPromise(fs.isFile(wsPath))) {
        try {
          const yamlData = parseSimpleYaml(await toPromise(fs.readText(wsPath)));
          sessionCwd = yamlData.cwd || yamlData.path || null;
          branch = yamlData.branch || yamlData.git_branch || null;
          yamlName = yamlData.name || yamlData.title || null;
        } catch {
          /* ignore */
        }
      }

      let metaTitle = null;
      const metaPath = joinPath(child, "meta.json");
      if (await toPromise(fs.isFile(metaPath))) {
        try {
          const data = JSON.parse(await toPromise(fs.readText(metaPath)));
          if (data && typeof data === "object") {
            metaTitle = data.title || data.name || null;
            if (!sessionCwd && typeof data.cwd === "string") sessionCwd = data.cwd;
            if (!branch && typeof data.branch === "string") branch = data.branch;
          }
        } catch {
          /* ignore */
        }
      }

      if (!sessionCwd || !pathMatchesCwd(sessionCwd, cwd)) return;

      const eventsPath = joinPath(child, "events.jsonl");
      let hasEvents = false;
      try {
        const size = await toPromise(fs.fileSize(eventsPath));
        hasEvents = size > 0;
      } catch {
        hasEvents = false;
      }
      const hasTurns = turnIds.has(sid);
      if (!hasEvents && !hasTurns) return;

      let firstUser = null;
      if (hasEvents) {
        try {
          const head = await toPromise(fs.readHead(eventsPath, { maxBytes: 256_000 }));
          firstUser = firstUserMessageFromEvents(head);
        } catch {
          firstUser = null;
        }
      }

      const updated = await toPromise(fs.mtimeMs(child));
      mergeCopilotSession(store, sid, {
        yaml_name: yamlName,
        meta_title: metaTitle,
        first_user: firstUser,
        cwd_val: sessionCwd,
        branch,
        updated,
        resumable: true,
      });
    });
  }

  if (opts.sqliteAvailable !== false) {
    try {
      await readCopilotDataDb(fs, home, store);
    } catch {
      /* ignore */
    }
  }

  const out = [];
  for (const [sid, meta] of Object.entries(store)) {
    if (!meta.resumable) continue;
    const title = pickDisplayTitle(sid, {
      db_title: meta.db_title,
      yaml_name: meta.yaml_name,
      meta_title: meta.meta_title,
      first_user: meta.first_user,
      cwd: meta.cwd,
      branch: meta.branch,
    });
    out.push(
      sessionRow(
        "copilot",
        sid,
        title,
        Math.trunc(meta.updated || 0),
        meta.branch,
        meta.cwd,
      ),
    );
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, PER_GROUP_CAP);
}

export { resolveCopilotHome, loadCopilotTurnIds };
