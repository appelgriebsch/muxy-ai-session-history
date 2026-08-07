import { joinPath } from "../../host-fs.js";
import {
  UUID_RE,
  PER_GROUP_CAP,
  ENRICH_SLACK,
  SCAN_CONCURRENCY,
  pathQuote,
  isoToMs,
  sessionRow,
  toPromise,
  mapPool,
  takeRecent,
} from "./helpers.js";

/**
 * List Grok sessions for cwd.
 * @param {*} fs
 * @param {string} cwd
 * @param {{ home?: string }} [opts]
 */
export async function listGrok(fs, cwd, opts = {}) {
  const home = opts.home ?? (await toPromise(fs.homeDir()));
  const root = joinPath(home, ".grok", "sessions", pathQuote(cwd));

  let entries;
  try {
    entries = await toPromise(fs.listDirDetailed(root));
  } catch {
    return [];
  }
  if (!entries.length) return [];

  const candidates = takeRecent(entries, {
    limit: PER_GROUP_CAP + ENRICH_SLACK,
    kind: "dir",
    nameOk: (name) => UUID_RE.test(name),
  });

  const rows = await mapPool(candidates, SCAN_CONCURRENCY, async (entry) => {
    const name = entry.name;
    const child = joinPath(root, name);
    let title = "(untitled)";
    let updated = entry.mtimeMs || 0;
    let sid = name;
    const summary = joinPath(child, "summary.json");
    try {
      const text = await toPromise(fs.readText(summary));
      const data = JSON.parse(text);
      if (data && typeof data === "object") {
        const info = data.info && typeof data.info === "object" ? data.info : {};
        if (typeof info.id === "string") sid = info.id;
        title =
          data.generated_title ||
          data.session_summary ||
          data.agent_name ||
          title;
        updated =
          isoToMs(data.updated_at || data.last_active_at) || updated;
        return sessionRow("grok", sid, String(title), updated, null);
      }
    } catch {
      /* missing or invalid summary — use dir mtime */
    }
    return sessionRow("grok", name, title, updated, null);
  });

  const out = rows.filter(Boolean);
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, PER_GROUP_CAP);
}
