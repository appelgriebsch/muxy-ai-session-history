import { joinPath } from "../../host-fs.js";
import {
  UUID_RE,
  PER_GROUP_CAP,
  slugify,
  normPath,
  claudeTitleFromJsonl,
  sessionRow,
  toPromise,
  mapPool,
} from "./helpers.js";

/**
 * List Claude Code sessions for cwd.
 * @param {*} fs
 * @param {string} cwd
 * @param {{ home?: string, claudeConfigDir?: string | null }} [opts]
 */
export async function listClaude(fs, cwd, opts = {}) {
  let base;
  if (opts.claudeConfigDir) {
    base = opts.claudeConfigDir;
  } else {
    const envDir = await toPromise(fs.env("CLAUDE_CONFIG_DIR"));
    if (envDir) {
      base = envDir.startsWith("~")
        ? joinPath(await toPromise(fs.homeDir()), envDir.slice(1).replace(/^\//, ""))
        : envDir;
    } else {
      base = joinPath(await toPromise(fs.homeDir()), ".claude");
    }
  }

  const projects = joinPath(base, "projects");
  if (!(await toPromise(fs.isDir(projects)))) return [];

  const expected = joinPath(projects, slugify(cwd));
  const dirs = [];
  if (await toPromise(fs.isDir(expected))) {
    dirs.push(expected);
  }
  try {
    const names = await toPromise(fs.listDir(projects));
    for (const name of names.slice().sort()) {
      const path = joinPath(projects, name);
      if (path === expected) continue;
      if (await toPromise(fs.isDir(path))) dirs.push(path);
    }
  } catch {
    /* ignore */
  }

  const out = [];
  const seen = new Set();

  for (const project of dirs) {
    let files;
    try {
      files = await toPromise(fs.listDir(project));
    } catch {
      continue;
    }
    const jsonl = files.filter(
      (f) => f.endsWith(".jsonl") && UUID_RE.test(f.replace(/\.jsonl$/, "")),
    );

    const rows = await mapPool(jsonl, 16, async (filename) => {
      const stem = filename.replace(/\.jsonl$/, "");
      if (seen.has(stem)) return null;
      const path = joinPath(project, filename);
      if (!(await toPromise(fs.isFile(path)))) return null;

      let head;
      try {
        head = await toPromise(fs.readHead(path, { maxBytes: 256_000 }));
      } catch {
        return null;
      }
      const { title, cwd: storedCwd, branch } = claudeTitleFromJsonl(head);
      if (storedCwd && normPath(storedCwd) !== normPath(cwd)) return null;
      if (!storedCwd && project !== expected) return null;
      seen.add(stem);
      const updated = await toPromise(fs.mtimeMs(path));
      return sessionRow("claude", stem, title, updated, branch);
    });

    for (const row of rows) {
      if (row) out.push(row);
    }
  }

  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, PER_GROUP_CAP);
}
