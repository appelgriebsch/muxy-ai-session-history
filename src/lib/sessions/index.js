import { buildGroups, filterGroups, flattenSessions } from "@/lib/sessions/group";
import { ensurePython3, listSessionsForCli } from "@/lib/sessions/scan";
import { detectInstalled } from "@/lib/sessions/which";
import { START_PREFERENCE, providerById } from "@/lib/sessions/providers";

const GLOBAL_CAP = 80;

/**
 * Load all sessions for installed CLIs at cwd.
 * @param {string} cwd
 * @param {{ archivedSet?: Set<string>, exec?: Function }} [opts]
 * @returns {Promise<{ installed, groups, sessionsByCli, errorsByCli, pythonMissing?: boolean }>}
 */
export async function listAll(cwd, opts = {}) {
  const { archivedSet } = opts;
  const exec = opts.exec ?? ((argv, options) => muxy.exec(argv, options));
  const installed = await detectInstalled();
  const sessionsByCli = {};
  const errorsByCli = {};

  if (!cwd) {
    return { installed, groups: [], sessionsByCli, errorsByCli };
  }

  const hasPython = await ensurePython3(exec);
  if (!hasPython) {
    return {
      installed,
      groups: [],
      sessionsByCli,
      errorsByCli: {
        _python:
          "Python 3 is required to read CLI session stores. Install python3 (Xcode CLT or python.org) and refresh.",
      },
      pythonMissing: true,
    };
  }

  const results = await Promise.allSettled(
    installed.map(async (provider) => {
      const sessions = await listSessionsForCli(provider.id, cwd, { archivedSet, exec });
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

export function pickStartCli(preferredCli, installed) {
  const ids = new Set(installed.map((p) => p.id));
  if (preferredCli && ids.has(preferredCli)) return preferredCli;
  for (const id of START_PREFERENCE) {
    if (ids.has(id)) return id;
  }
  return installed[0]?.id ?? null;
}

export { filterGroups, flattenSessions, providerById, detectInstalled };
