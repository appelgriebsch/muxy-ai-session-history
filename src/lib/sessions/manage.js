import { isSafeSessionId } from "../sanitize.js";
import { setSessionArchived } from "../storage.js";
import { createHostFs } from "../host-fs.js";
import { renameSessionJs, deleteSessionJs } from "./manage/index.js";

/**
 * Rename a session's title via host-fs JS managers.
 * @param {string} cli
 * @param {string} sessionId
 * @param {string} newTitle
 * @param {{ exec?: Function, fs?: object }} [opts]
 */
export async function renameSession(cli, sessionId, newTitle, opts = {}) {
  if (!isSafeSessionId(sessionId)) throw new Error("Invalid session id");
  if (!newTitle || !newTitle.trim()) throw new Error("Title must not be empty");
  const exec = opts.exec ?? ((argv, options) => muxy.exec(argv, options));
  const fs = opts.fs ?? createHostFs(exec);
  await renameSessionJs(fs, cli, sessionId, newTitle);
}

/**
 * Delete a session via host-fs JS managers.
 * @param {string} cli
 * @param {string} sessionId
 * @param {string} [cwd]
 * @param {{ exec?: Function, fs?: object }} [opts]
 */
export async function deleteSession(cli, sessionId, cwd, opts = {}) {
  if (!isSafeSessionId(sessionId)) throw new Error("Invalid session id");
  const exec = opts.exec ?? ((argv, options) => muxy.exec(argv, options));
  const fs = opts.fs ?? createHostFs(exec);
  await deleteSessionJs(fs, cli, sessionId, cwd);
}

/**
 * Archive or unarchive a session (Muxy extension storage only).
 * Does not flip native CLI flags (e.g. Codex threads.archived) so sessions
 * remain listable and resumable from the CLI.
 * @param {string} cli
 * @param {string} sessionId
 * @param {boolean} archived
 * @param {{ exec?: Function }} [opts]
 */
export async function archiveSession(cli, sessionId, archived, _opts = {}) {
  if (!isSafeSessionId(sessionId)) throw new Error("Invalid session id");
  await setSessionArchived(cli, sessionId, archived);
}
