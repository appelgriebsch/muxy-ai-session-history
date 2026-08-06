import { oneLine, isSafeSessionId } from "../sanitize.js";
import {
  createHostFs,
  ensureHostTools,
  resetHostToolsProbe,
  hasSqlite3,
  chain,
} from "../host-fs.js";
import { listSessionsJs } from "./scan/index.js";
import { toPromise } from "./scan/helpers.js";

function normalizeSession(raw, cli, archivedSet) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id;
  if (!isSafeSessionId(id)) return null;
  return {
    id,
    title: oneLine(raw.title) || "(untitled)",
    updatedAt: Number(raw.updatedAt) || 0,
    branch: typeof raw.branch === "string" ? raw.branch : null,
    cwd: typeof raw.cwd === "string" && raw.cwd ? raw.cwd : null,
    cli,
    archived: archivedSet ? archivedSet.has(`${cli}:${id}`) : false,
  };
}

/** @type {boolean | null} */
let sqliteAvailableCache = null;

export function resetSqliteProbe() {
  sqliteAvailableCache = null;
}

/**
 * Probe host for required tools once per panel lifetime.
 * @param {Function} exec
 */
export async function ensureHostToolsReady(exec) {
  return Boolean(await toPromise(ensureHostTools(exec)));
}

/** @deprecated Use ensureHostToolsReady */
export async function ensurePython3(exec) {
  return ensureHostToolsReady(exec);
}

export function resetPython3Probe() {
  resetHostToolsProbe();
  resetSqliteProbe();
}

export { resetHostToolsProbe };

async function resolveSqlite(exec) {
  if (sqliteAvailableCache != null) return sqliteAvailableCache;
  try {
    sqliteAvailableCache = Boolean(await toPromise(hasSqlite3(exec)));
  } catch {
    sqliteAvailableCache = false;
  }
  return sqliteAvailableCache;
}

/**
 * List sessions for one CLI + cwd via pure JS scanners + host-fs.
 * @param {string} cli
 * @param {string} cwd
 * @param {{ exec?: Function, archivedSet?: Set<string>, fs?: object }} [opts]
 */
export async function listSessionsForCli(cli, cwd, opts = {}) {
  const exec = opts.exec ?? ((argv, options) => muxy.exec(argv, options));
  const fs = opts.fs ?? createHostFs(exec);
  const sqliteAvailable = await resolveSqlite(exec);
  try {
    const rows = await listSessionsJs(fs, cli, cwd, { sqliteAvailable });
    return (rows || [])
      .map((item) => normalizeSession(item, cli, opts.archivedSet))
      .filter(Boolean);
  } catch (err) {
    // Soft-fail message for sqlite-dependent CLIs
    if (
      (cli === "codex" || cli === "copilot") &&
      !sqliteAvailable &&
      /sqlite/i.test(String(err?.message || err))
    ) {
      throw new Error(
        `${cli}: /usr/bin/sqlite3 is required to read session stores on this host`,
      );
    }
    throw err;
  }
}

/**
 * Synchronous-friendly variant for runScript.
 * When exec is sync, host-fs methods return plain values; we still use async
 * scanners (await on plain values is fine) so callers may await this.
 * @param {string} cli
 * @param {string} cwd
 * @param {Function | { exec?: Function, archivedSet?: Set<string>, fs?: object }} [execOrOpts]
 */
export function listSessionsForCliSync(cli, cwd, execOrOpts = muxy.exec) {
  const opts =
    typeof execOrOpts === "function" ? { exec: execOrOpts } : execOrOpts ?? {};
  const exec = opts.exec ?? muxy.exec;
  // Return a thenable that runScript can treat as sync if already resolved —
  // but scanners are async functions. For runScript, use listSessionsForCli
  // with a sync exec (await on non-promises works in async functions).
  // Callers in runScript should use the built picker's async-free path via
  // the bundled IIFE which uses Promise-less chain for sync exec when possible.
  return listSessionsForCli(cli, cwd, { ...opts, exec });
}

// re-export chain for tests
export { chain };
