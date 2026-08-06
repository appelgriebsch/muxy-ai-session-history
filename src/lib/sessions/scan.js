import { oneLine, isSafeSessionId } from "@/lib/sanitize";
import scannerSource from "@/lib/sessions/scanner.py?raw";

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
let python3Available = null;

/**
 * Probe host for python3 once per panel lifetime.
 * @param {Function} exec
 */
export async function ensurePython3(exec) {
  if (python3Available === true) return true;
  if (python3Available === false) return false;
  try {
    const result = await exec(["bash", "-lc", "command -v python3"], { timeoutMs: 8000 });
    const out = String(result?.stdout ?? "").trim();
    const code = result?.exitCode ?? result?.code ?? 1;
    python3Available = code === 0 && out.length > 0;
  } catch {
    python3Available = false;
  }
  return python3Available;
}

export function resetPython3Probe() {
  python3Available = null;
}

function parseScannerOutput(stdout, exitCode, cli, archivedSet) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    if (exitCode !== 0) throw new Error(`Scanner failed for ${cli} (exit ${exitCode})`);
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const lines = text.split("\n").filter(Boolean);
    parsed = JSON.parse(lines[lines.length - 1]);
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.error) {
    throw new Error(String(parsed.error));
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.map((item) => normalizeSession(item, cli, archivedSet)).filter(Boolean);
}

/**
 * List sessions for one CLI + cwd via the bundled Python scanner (stdin to python3 -).
 * @param {string} cli
 * @param {string} cwd
 * @param {{ exec?: Function, archivedSet?: Set<string> }} [opts] — optional sync/async exec (panel uses muxy.exec)
 */
export async function listSessionsForCli(cli, cwd, opts = {}) {
  const exec = opts.exec ?? ((argv, options) => muxy.exec(argv, options));
  const result = await exec(["python3", "-", cli, cwd], {
    timeoutMs: 20000,
    stdin: scannerSource,
  });
  const exitCode = result?.exitCode ?? result?.code ?? 0;
  return parseScannerOutput(result?.stdout, exitCode, cli, opts.archivedSet);
}

/**
 * Synchronous variant for runScript (muxy.exec is sync there).
 * @param {string} cli
 * @param {string} cwd
 * @param {Function | { exec?: Function, archivedSet?: Set<string> }} [execOrOpts]
 */
export function listSessionsForCliSync(cli, cwd, execOrOpts = muxy.exec) {
  const opts =
    typeof execOrOpts === "function" ? { exec: execOrOpts } : execOrOpts ?? {};
  const exec = opts.exec ?? muxy.exec;
  const result = exec(["python3", "-", cli, cwd], {
    timeoutMs: 20000,
    stdin: scannerSource,
  });
  const exitCode = result?.exitCode ?? result?.code ?? 0;
  return parseScannerOutput(result?.stdout, exitCode, cli, opts.archivedSet);
}
