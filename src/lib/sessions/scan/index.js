import { listGrok } from "./grok.js";
import { listCursor } from "./cursor.js";
import { listClaude } from "./claude.js";
import { listCodex } from "./codex.js";
import { listCopilot } from "./copilot.js";
import { toPromise } from "./helpers.js";
import { hasSqlite3 } from "../../host-fs.js";

/**
 * List sessions for one CLI using pure JS + host-fs.
 * @param {*} fs  createHostFs instance
 * @param {string} cli
 * @param {string} cwd
 * @param {{ sqliteAvailable?: boolean }} [opts]
 */
export async function listSessionsJs(fs, cli, cwd, opts = {}) {
  const id = String(cli || "").toLowerCase();
  let sqliteAvailable = opts.sqliteAvailable;
  if (sqliteAvailable === undefined && (id === "codex" || id === "copilot")) {
    try {
      // Prefer fs-level probe if caller didn't inject; host-fs doesn't expose exec.
      sqliteAvailable = true;
    } catch {
      sqliteAvailable = true;
    }
  }

  switch (id) {
    case "grok":
      return listGrok(fs, cwd, opts);
    case "cursor":
      return listCursor(fs, cwd, opts);
    case "claude":
      return listClaude(fs, cwd, opts);
    case "codex":
      return listCodex(fs, cwd, { ...opts, sqliteAvailable });
    case "copilot":
      return listCopilot(fs, cwd, { ...opts, sqliteAvailable });
    default:
      throw new Error(`unknown cli: ${cli}`);
  }
}

/**
 * Probe sqlite availability via the same exec used for host-fs.
 * @param {Function} exec
 */
export async function probeSqlite(exec) {
  return Boolean(await toPromise(hasSqlite3(exec)));
}
