import managerSource from "@/lib/sessions/manage.py?raw";
import { isSafeSessionId } from "@/lib/sanitize";
import { setSessionArchived } from "@/lib/storage";

/**
 * Run the Python management script via muxy.exec.
 * @param {string[]} args  Arguments after the script itself.
 * @param {{ exec?: Function }} [opts]
 */
async function runManager(args, opts = {}) {
  const exec = opts.exec ?? ((argv, options) => muxy.exec(argv, options));
  const result = await exec(["python3", "-", ...args], {
    timeoutMs: 15000,
    stdin: managerSource,
  });
  const stdout = String(result?.stdout ?? "").trim();
  const exitCode = result?.exitCode ?? result?.code ?? 0;
  if (!stdout) {
    if (exitCode !== 0) throw new Error(`Manager script failed (exit ${exitCode})`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Unexpected manager output: ${stdout}`);
  }
  if (parsed && parsed.error) throw new Error(String(parsed.error));
}

/**
 * Rename a session's title via the Python manager script.
 * @param {string} cli
 * @param {string} sessionId
 * @param {string} newTitle
 * @param {{ exec?: Function }} [opts]
 */
export async function renameSession(cli, sessionId, newTitle, opts = {}) {
  if (!isSafeSessionId(sessionId)) throw new Error("Invalid session id");
  if (!newTitle || !newTitle.trim()) throw new Error("Title must not be empty");
  await runManager(["rename", cli, sessionId, newTitle], opts);
}

/**
 * Delete a session via the Python manager script.
 * @param {string} cli
 * @param {string} sessionId
 * @param {string} [cwd]
 * @param {{ exec?: Function }} [opts]
 */
export async function deleteSession(cli, sessionId, cwd, opts = {}) {
  if (!isSafeSessionId(sessionId)) throw new Error("Invalid session id");
  const args = ["delete", cli, sessionId];
  if (cwd) args.push(cwd);
  await runManager(args, opts);
}

/**
 * Archive or unarchive a session.
 * For codex, also updates the native DB via the Python manager script.
 * For all CLIs, the archived state is stored in muxy extension storage.
 * @param {string} cli
 * @param {string} sessionId
 * @param {boolean} archived
 * @param {{ exec?: Function }} [opts]
 */
export async function archiveSession(cli, sessionId, archived, opts = {}) {
  if (!isSafeSessionId(sessionId)) throw new Error("Invalid session id");
  if (cli === "codex") {
    await runManager(["archive", cli, sessionId, archived ? "1" : "0"], opts);
  }
  await setSessionArchived(cli, sessionId, archived);
}
