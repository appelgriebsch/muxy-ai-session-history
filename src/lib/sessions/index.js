import { buildGroups, filterGroups, flattenSessions } from "@/lib/sessions/group";
import { createHostFs } from "@/lib/host-fs";
import {
  ensureHostToolsReady,
  listSessionsForCli,
  resolveSqliteAvailable,
} from "@/lib/sessions/scan";
import { detectInstalled } from "@/lib/sessions/which";
import { providerById } from "@/lib/sessions/providers";
import { toPromise } from "@/lib/sessions/scan/helpers";

const GLOBAL_CAP = 80;

/**
 * Load all sessions for installed CLIs at cwd.
 * @param {string} cwd
 * @param {{ exec?: Function, fs?: object, home?: string, sqliteAvailable?: boolean }} [opts]
 * @returns {Promise<{ installed, groups, sessionsByCli, errorsByCli, hostToolsMissing?: boolean }>}
 */
export async function listAll(cwd, opts = {}) {
  const exec = opts.exec ?? ((argv, options) => muxy.exec(argv, options));
  const installed = await detectInstalled();
  const sessionsByCli = {};
  const errorsByCli = {};

  if (!cwd) {
    return { installed, groups: [], sessionsByCli, errorsByCli };
  }

  const hasTools = await ensureHostToolsReady(exec);
  if (!hasTools) {
    return {
      installed,
      groups: [],
      sessionsByCli,
      errorsByCli: {
        _host:
          "Host tools (cat, ls, stat, tee, …) are required to read CLI session stores. Install coreutils/Xcode CLT and refresh.",
      },
      hostToolsMissing: true,
    };
  }

  // One host-fs + home + sqlite probe shared across all CLI scanners.
  const fs = opts.fs ?? createHostFs(exec);
  let home = opts.home;
  if (home == null) {
    try {
      home = await toPromise(fs.homeDir());
    } catch {
      home = undefined;
    }
  }
  const sqliteAvailable =
    opts.sqliteAvailable !== undefined
      ? Boolean(opts.sqliteAvailable)
      : await resolveSqliteAvailable(exec);

  const results = await Promise.allSettled(
    installed.map(async (provider) => {
      const sessions = await listSessionsForCli(provider.id, cwd, {
        exec,
        fs,
        home,
        sqliteAvailable,
      });
      return { id: provider.id, sessions };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const provider = installed[i];
    const result = results[i];
    if (result.status === "fulfilled") {
      sessionsByCli[provider.id] = result.value.sessions.slice(0, 25);
    } else {
      sessionsByCli[provider.id] = [];
      errorsByCli[provider.id] =
        result.reason?.message || String(result.reason) || "Failed to load sessions";
    }
  }

  // Soft global cap: trim oldest across groups if needed
  let groups = buildGroups(installed, sessionsByCli, errorsByCli);
  let total = groups.reduce((n, g) => n + g.sessions.length, 0);
  if (total > GLOBAL_CAP) {
    const flat = flattenSessions(groups).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const keep = new Set(flat.slice(0, GLOBAL_CAP).map((s) => `${s.cli}:${s.id}`));
    for (const g of groups) {
      g.sessions = g.sessions.filter((s) => keep.has(`${s.cli}:${s.id}`));
    }
    groups = groups.filter((g) => g.sessions.length || g.error);
  }

  return { installed, groups, sessionsByCli, errorsByCli };
}

export { filterGroups, flattenSessions, providerById, detectInstalled };
