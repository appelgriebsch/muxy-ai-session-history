import { joinPath } from "../../host-fs.js";
import {
  UUID_RE,
  PER_GROUP_CAP,
  ENRICH_SLACK,
  SCAN_CONCURRENCY,
  slugify,
  normPath,
  claudeTitleFromJsonl,
  sessionRow,
  toPromise,
  mapPool,
} from "./helpers.js";

/**
 * Collect UUID .jsonl file candidates under one project dir.
 * @param {*} fs
 * @param {string} project
 */
async function collectJsonlCandidates(fs, project) {
  /** @type {Array<{ path: string, stem: string, project: string, mtimeMs: number }>} */
  const out = [];
  let files;
  try {
    files = await toPromise(fs.listDirDetailed(project));
  } catch {
    return out;
  }
  for (const f of files) {
    if (f.kind !== "file") continue;
    if (!f.name.endsWith(".jsonl")) continue;
    const stem = f.name.replace(/\.jsonl$/, "");
    if (!UUID_RE.test(stem)) continue;
    out.push({
      path: joinPath(project, f.name),
      stem,
      project,
      mtimeMs: f.mtimeMs || 0,
    });
  }
  return out;
}

/**
 * @param {*} fs
 * @param {Array<{ path: string, stem: string, project: string, mtimeMs: number }>} toEnrich
 * @param {string} cwd
 * @param {string} expected
 * @param {Set<string>} seen
 */
async function enrichClaudeCandidates(fs, toEnrich, cwd, expected, seen) {
  const rows = await mapPool(toEnrich, SCAN_CONCURRENCY, async (c) => {
    if (seen.has(c.stem)) return null;
    let head;
    try {
      head = await toPromise(fs.readHead(c.path, { maxBytes: 256_000 }));
    } catch {
      return null;
    }
    const { title, cwd: storedCwd, branch } = claudeTitleFromJsonl(head);
    if (storedCwd && normPath(storedCwd) !== normPath(cwd)) return null;
    if (!storedCwd && c.project !== expected) return null;
    seen.add(c.stem);
    return sessionRow("claude", c.stem, title, c.mtimeMs || 0, branch);
  });
  return rows.filter(Boolean);
}

/**
 * List Claude Code sessions for cwd.
 * Metadata-first: list project dirs + jsonl mtimes, then readHead only top candidates.
 * Expected project slug is enriched first so foreign recent files cannot starve cwd matches.
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
      base = joinPath(opts.home ?? (await toPromise(fs.homeDir())), ".claude");
    }
  }

  const projects = joinPath(base, "projects");
  const projectEntries = await toPromise(fs.listDirDetailed(projects));
  if (!projectEntries.length) return [];

  const expected = joinPath(projects, slugify(cwd));
  const dirEntries = projectEntries.filter((e) => e.kind === "dir");
  const foreignProjects = dirEntries
    .filter((e) => joinPath(projects, e.name) !== expected)
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .map((e) => joinPath(projects, e.name));

  const seen = new Set();
  /** @type {Array} */
  let out = [];

  // Phase 1: expected project (cwd-primary).
  const expectedExists = dirEntries.some((e) => joinPath(projects, e.name) === expected);
  if (expectedExists) {
    const local = await collectJsonlCandidates(fs, expected);
    local.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    const toEnrich = local.slice(0, PER_GROUP_CAP + ENRICH_SLACK);
    out = out.concat(await enrichClaudeCandidates(fs, toEnrich, cwd, expected, seen));
  }

  // Phase 2: foreign projects only if we still need rows (cwd may live under another slug).
  if (out.length < PER_GROUP_CAP) {
    const remaining = PER_GROUP_CAP + ENRICH_SLACK - out.length;
    /** @type {Array<{ path: string, stem: string, project: string, mtimeMs: number }>} */
    const foreignCandidates = [];
    for (const project of foreignProjects) {
      const part = await collectJsonlCandidates(fs, project);
      for (const c of part) foreignCandidates.push(c);
      // Bound how many foreign project dirs we fully list (metadata only).
      if (foreignCandidates.length >= remaining * 4) break;
    }
    foreignCandidates.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    const toEnrich = foreignCandidates.slice(0, remaining);
    out = out.concat(await enrichClaudeCandidates(fs, toEnrich, cwd, expected, seen));
  }

  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, PER_GROUP_CAP);
}
