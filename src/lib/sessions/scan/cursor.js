import { joinPath } from "../../host-fs.js";
import {
  PER_GROUP_CAP,
  md5Hex,
  isoToMs,
  sessionRow,
  toPromise,
  mapPool,
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
  const isDir = await toPromise(fs.isDir(root));
  if (!isDir) return [];

  const names = await toPromise(fs.listDir(root));
  const rows = await mapPool(names, 16, async (name) => {
    const child = joinPath(root, name);
    const childIsDir = await toPromise(fs.isDir(child));
    if (!childIsDir) return null;

    let title = "(untitled)";
    let updated = await toPromise(fs.mtimeMs(child));
    let branch = null;
    const metaPath = joinPath(child, "meta.json");
    const hasMeta = await toPromise(fs.isFile(metaPath));
    if (hasMeta) {
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
        /* ignore */
      }
    }
    return sessionRow("cursor", name, String(title), updated, branch);
  });

  const out = rows.filter(Boolean);
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, PER_GROUP_CAP);
}
