import { joinPath } from "../../host-fs.js";
import {
  UUID_RE,
  PER_GROUP_CAP,
  pathQuote,
  isoToMs,
  sessionRow,
  toPromise,
  mapPool,
} from "./helpers.js";

/**
 * List Grok sessions for cwd.
 * @param {import("@/lib/host-fs").createHostFs extends Function ? any : any} fs
 * @param {string} cwd
 * @param {{ home?: string }} [opts]
 */
export async function listGrok(fs, cwd, opts = {}) {
  const home = opts.home ?? (await toPromise(fs.homeDir()));
  const root = joinPath(home, ".grok", "sessions", pathQuote(cwd));
  const isDir = await toPromise(fs.isDir(root));
  if (!isDir) return [];

  const names = await toPromise(fs.listDir(root));
  const candidates = names.filter((name) => UUID_RE.test(name));

  const rows = await mapPool(candidates, 16, async (name) => {
    const child = joinPath(root, name);
    const childIsDir = await toPromise(fs.isDir(child));
    if (!childIsDir) return null;

    let title = "(untitled)";
    let updated = await toPromise(fs.mtimeMs(child));
    let sid = name;
    const summary = joinPath(child, "summary.json");
    const hasSummary = await toPromise(fs.isFile(summary));
    if (hasSummary) {
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
        /* fall through */
      }
    }
    return sessionRow("grok", name, title, updated, null);
    // (symlinks: isDir is false for symlink dirs — intentional non-follow)
  });

  const out = rows.filter(Boolean);
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, PER_GROUP_CAP);
}
