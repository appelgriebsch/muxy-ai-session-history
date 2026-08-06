const PREFERRED_CLI = "preferredCli";
const LIST_FILTER = "listFilter";
const ARCHIVED_SESSIONS = "archivedSessions";
const SHOW_ARCHIVED = "showArchived";

export async function getPreferredCli() {
  const value = await muxy.storage.get(PREFERRED_CLI);
  return typeof value === "string" && value ? value : "grok";
}

export async function setPreferredCli(cli) {
  await muxy.storage.set(PREFERRED_CLI, cli);
}

export async function getListFilter() {
  const value = await muxy.storage.get(LIST_FILTER);
  return typeof value === "string" && value ? value : "all";
}

export async function setListFilter(filter) {
  await muxy.storage.set(LIST_FILTER, filter);
}

/** Returns a Set of "cli:id" keys for archived sessions. */
export async function getArchivedSessions() {
  const value = await muxy.storage.get(ARCHIVED_SESSIONS);
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

export async function setSessionArchived(cli, id, archived) {
  const current = await getArchivedSessions();
  const key = `${cli}:${id}`;
  if (archived) {
    current.add(key);
  } else {
    current.delete(key);
  }
  await muxy.storage.set(ARCHIVED_SESSIONS, [...current]);
}

export async function getShowArchived() {
  const value = await muxy.storage.get(SHOW_ARCHIVED);
  return value === true;
}

export async function setShowArchived(show) {
  await muxy.storage.set(SHOW_ARCHIVED, show);
}
