import { joinPath } from "../../host-fs.js";
import {
  PER_GROUP_CAP,
  ENRICH_SLACK,
  SCAN_CONCURRENCY,
  md5Hex,
  isoToMs,
  sessionRow,
  toPromise,
  mapPool,
  takeRecent,
} from "./helpers.js";

/**
 * List Cursor Agent sessions for cwd.
 * @param {*} fs  HostFs
 * @param {string} cwd
 * @param {{ home?: string }} [opts]
 */
export async function listCursor(fs, cwd, opts = {}) {
  const home = opts.home ?? (await toPromise(fs.homeDir()));
  const hash = md5Hex(cwd);
  const root = joinPath(home, ".cursor", "chats", hash);

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
  });

  const rows = await mapPool(candidates, SCAN_CONCURRENCY, async (entry) => {
    const name = entry.name;
    const child = joinPath(root, name);
    let title = "(untitled)";
    let updated = entry.mtimeMs || 0;
    let branch = null;
    const metaPath = joinPath(child, "meta.json");
    try {
      const data = JSON.parse(await toPromise(fs.readText(metaPath)));
      if (data && typeof data === "object") {
        title = data.title || data.name || title;
        updated =
          isoToMs(data.updatedAtMs || data.updatedAt || data.updated_at) ||
          updated;
        if (typeof data.branch === "string") branch = data.branch;
      }
    } catch {
      /* missing or invalid meta */
    }
    return sessionRow("cursor", name, String(title), updated, branch);
  });

  const out = rows.filter(Boolean);
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, PER_GROUP_CAP);
}
