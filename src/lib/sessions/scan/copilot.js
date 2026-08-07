import { joinPath, chain } from "../../host-fs.js";
import { isSafeSessionId, isCopilotStubId } from "../../sanitize.js";
import {
  PER_GROUP_CAP,
  COPILOT_MAX_STATE_DIRS,
  isoToMs,
  sessionRow,
  parseSimpleYaml,
  pathMatchesCwd,
  firstUserMessageFromEvents,
  pickDisplayTitle,
  resolveTitleLikeColumn,
  mapSeq,
  tryChain,
  takeRecent,
} from "./helpers.js";

/**
 * @param {*} fs
 * @param {{ home?: string, copilotHome?: string | null }} [opts]
 */
function resolveCopilotHome(fs, opts = {}) {
  if (opts.copilotHome) return opts.copilotHome;
  return chain(fs.env("COPILOT_HOME"), (envHome) => {
    if (envHome) {
      if (envHome.startsWith("~")) {
        const homeP = opts.home != null ? opts.home : fs.homeDir();
        return chain(homeP, (home) =>
          joinPath(home, envHome.slice(1).replace(/^\//, "")),
        );
      }
      return envHome;
    }
    const homeP = opts.home != null ? opts.home : fs.homeDir();
    return chain(homeP, (home) => joinPath(home, ".copilot"));
  });
}

/**
 * Session ids with at least one turn row.
 * @param {*} fs
 * @param {string} home
 * @returns {Set<string> | Promise<Set<string>>}
 */
function loadCopilotTurnIds(fs, home) {
  const found = new Set();
  const dbNames = ["session-store.db", "data.db"];
  return chain(
    mapSeq(dbNames, (dbName) => {
      const dbPath = joinPath(home, dbName);
      return chain(fs.isFile(dbPath), (isFile) => {
        if (!isFile) return null;
        return chain(tryChain(() => fs.sqliteTables(dbPath), null), (tables) => {
          if (!tables || !tables.has("turns")) return null;
          return chain(
            tryChain(() => fs.sqliteTableColumns(dbPath, "turns"), null),
            (cols) => {
              if (!cols) return null;
              const sidCol = ["session_id", "sessionId", "id"].find((c) => cols.has(c));
              if (!sidCol) return null;
              return chain(
                tryChain(
                  () =>
                    fs.sqliteQuery(
                      dbPath,
                      `SELECT DISTINCT ${sidCol} AS sid FROM turns WHERE ${sidCol} IS NOT NULL`,
                    ),
                  [],
                ),
                (rows) => {
                  for (const r of rows || []) {
                    if (typeof r.sid === "string" && r.sid) found.add(r.sid);
                  }
                  return null;
                },
              );
            },
          );
        });
      });
    }),
    () => found,
  );
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
function readCopilotDataDb(fs, home, store) {
  const dbNames = ["data.db", "session-store.db"];
  return mapSeq(dbNames, (dbName) => {
    const dbPath = joinPath(home, dbName);
    return chain(fs.isFile(dbPath), (isFile) => {
      if (!isFile) return null;
      return chain(tryChain(() => fs.sqliteTables(dbPath), null), (tables) => {
        if (!tables) return null;

        if (tables.has("sessions")) {
          return chain(
            tryChain(() => fs.sqliteTableColumns(dbPath, "sessions"), null),
            (scols) => {
              if (!scols || !scols.has("id")) {
                return readFallbackTables(fs, dbPath, tables, store);
              }
              const titleExpr = resolveTitleLikeColumn(scols) || "NULL";
              const updatedExpr =
                [
                  "updated_at",
                  "updatedAt",
                  "updated_at_ms",
                  "last_active_at",
                  "created_at",
                ].find((c) => scols.has(c)) || "NULL";
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

              const loadWs = tables.has("workspaces")
                ? chain(
                    tryChain(() => fs.sqliteTableColumns(dbPath, "workspaces"), null),
                    (wcols) => {
                      if (!wcols) return null;
                      const sidCol = ["session_id", "sessionId", "id"].find((c) =>
                        wcols.has(c),
                      );
                      const pathCol = [
                        "cwd",
                        "path",
                        "workspace_path",
                        "workspacePath",
                        "directory",
                      ].find((c) => wcols.has(c));
                      const branchCol = ["branch", "git_branch"].find((c) =>
                        wcols.has(c),
                      );
                      if (!sidCol) return null;
                      const sel = [
                        `${sidCol} AS sid`,
                        pathCol ? `${pathCol} AS wpath` : "NULL AS wpath",
                        branchCol ? `${branchCol} AS wbranch` : "NULL AS wbranch",
                      ];
                      return chain(
                        tryChain(
                          () =>
                            fs.sqliteQuery(
                              dbPath,
                              `SELECT ${sel.join(", ")} FROM workspaces LIMIT 500`,
                            ),
                          [],
                        ),
                        (wrows) => {
                          for (const w of wrows || []) {
                            if (typeof w.sid === "string") {
                              wsBySid[w.sid] = [
                                typeof w.wpath === "string" ? w.wpath : null,
                                typeof w.wbranch === "string" ? w.wbranch : null,
                              ];
                            }
                          }
                          return null;
                        },
                      );
                    },
                  )
                : null;

              return chain(loadWs, () => {
                const sql =
                  `SELECT id AS sid, ${titleExpr} AS title, ${updatedExpr} AS updated, ` +
                  `${sessPathCol ? `${sessPathCol} AS sess_path` : "NULL AS sess_path"}, ` +
                  `${sessBranchCol ? `${sessBranchCol} AS sess_branch` : "NULL AS sess_branch"} ` +
                  `FROM sessions ORDER BY rowid DESC LIMIT 300`;
                return chain(
                  tryChain(() => fs.sqliteQuery(dbPath, sql), []),
                  (srows) => {
                    for (const row of srows || []) {
                      const sid = row.sid;
                      if (typeof sid !== "string" || !(sid in store)) continue;
                      const [wpath, wbranch] = wsBySid[sid] || [null, null];
                      const pathVal =
                        wpath ||
                        (typeof row.sess_path === "string" ? row.sess_path : null);
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
                    return null;
                  },
                );
              });
            },
          );
        }

        return readFallbackTables(fs, dbPath, tables, store);
      });
    });
  });
}

/**
 * @param {*} fs
 * @param {string} dbPath
 * @param {Set<string>} tables
 * @param {Record<string, any>} store
 */
function readFallbackTables(fs, dbPath, tables, store) {
  const tableList = ["session", "session_docs", "chronicle", "sessions"];
  return mapSeq(tableList, (table) => {
    if (!tables.has(table)) return null;
    return chain(
      tryChain(() => fs.sqliteTableColumns(dbPath, table), null),
      (cols) => {
        if (!cols) return null;
        const idCol = ["id", "session_id", "sessionId"].find((c) => cols.has(c));
        if (!idCol) return null;
        const titleCol = resolveTitleLikeColumn(cols);
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
        return chain(tryChain(() => fs.sqliteQuery(dbPath, sql), []), (rows) => {
          for (const row of rows || []) {
            if (typeof row.sid !== "string" || !row.sid || !(row.sid in store)) continue;
            mergeCopilotSession(store, row.sid, {
              db_title: row.title,
              cwd_val: typeof row.path_val === "string" ? row.path_val : null,
              updated: isoToMs(row.updated) || 0,
              resumable: false,
            });
          }
          return null;
        });
      },
    );
  });
}

/**
 * List CLI-resumable Copilot sessions.
 * Returns plain array when fs is sync; Promise when exec is async.
 * @param {*} fs
 * @param {string} cwd
 * @param {{ home?: string, copilotHome?: string | null, sqliteAvailable?: boolean }} [opts]
 */
export function listCopilot(fs, cwd, opts = {}) {
  return chain(resolveCopilotHome(fs, opts), (home) => {
    /** @type {Record<string, any>} */
    const store = {};

    const turnIdsP =
      opts.sqliteAvailable === false
        ? new Set()
        : tryChain(() => loadCopilotTurnIds(fs, home), new Set());

    return chain(turnIdsP, (turnIds) => {
      const state = joinPath(home, "session-state");
      return chain(tryChain(() => fs.listDirDetailed(state), []), (stateEntries) => {
        const children = stateEntries.length
          ? takeRecent(stateEntries, {
              limit: COPILOT_MAX_STATE_DIRS,
              kind: "dir",
              nameOk: (name) => isSafeSessionId(name) && !isCopilotStubId(name),
            })
          : [];

        return chain(
          mapSeq(children, (entry) => {
            const name = entry.name;
            const child = joinPath(state, name);
            const sid = name;

            const wsPath = joinPath(child, "workspace.yaml");
            return chain(tryChain(() => fs.readText(wsPath), null), (yamlText) => {
              let sessionCwd = null;
              let branch = null;
              let yamlName = null;
              if (yamlText) {
                try {
                  const yamlData = parseSimpleYaml(yamlText);
                  sessionCwd = yamlData.cwd || yamlData.path || null;
                  branch = yamlData.branch || yamlData.git_branch || null;
                  yamlName = yamlData.name || yamlData.title || null;
                } catch {
                  /* ignore */
                }
              }

              const metaPath = joinPath(child, "meta.json");
              return chain(tryChain(() => fs.readText(metaPath), null), (metaText) => {
                let metaTitle = null;
                if (metaText) {
                  try {
                    const data = JSON.parse(metaText);
                    if (data && typeof data === "object") {
                      metaTitle = data.title || data.name || null;
                      if (!sessionCwd && typeof data.cwd === "string") {
                        sessionCwd = data.cwd;
                      }
                      if (!branch && typeof data.branch === "string") {
                        branch = data.branch;
                      }
                    }
                  } catch {
                    /* ignore */
                  }
                }

                if (!sessionCwd || !pathMatchesCwd(sessionCwd, cwd)) return null;

                const eventsPath = joinPath(child, "events.jsonl");
                return chain(
                  tryChain(() => fs.fileSize(eventsPath), 0),
                  (size) => {
                    const hasEvents = size > 0;
                    const hasTurns = turnIds.has(sid);
                    if (!hasEvents && !hasTurns) return null;

                    const firstUserP = hasEvents
                      ? chain(
                          tryChain(
                            () => fs.readHead(eventsPath, { maxBytes: 256_000 }),
                            null,
                          ),
                          (head) =>
                            head != null ? firstUserMessageFromEvents(head) : null,
                        )
                      : null;

                    return chain(firstUserP, (firstUser) => {
                      const updated = entry.mtimeMs || 0;
                      mergeCopilotSession(store, sid, {
                        yaml_name: yamlName,
                        meta_title: metaTitle,
                        first_user: firstUser,
                        cwd_val: sessionCwd,
                        branch,
                        updated,
                        resumable: true,
                      });
                      return null;
                    });
                  },
                );
              });
            });
          }),
          () => {
            const enrichP =
              opts.sqliteAvailable === false
                ? null
                : tryChain(() => readCopilotDataDb(fs, home, store), null);

            return chain(enrichP, () => {
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
            });
          },
        );
      });
    });
  });
}

export { resolveCopilotHome, loadCopilotTurnIds };
