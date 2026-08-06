import { START_PREFERENCE, providerById } from "./providers.js";

/**
 * Resolve which CLI to start: preferred if installed, else first in START_PREFERENCE, else first installed.
 * @param {string | null | undefined} preferredCli
 * @param {{ id: string }[]} installed
 * @returns {string | null}
 */
export function pickStartCli(preferredCli, installed) {
  const ids = new Set(installed.map((p) => p.id));
  if (preferredCli && ids.has(preferredCli)) return preferredCli;
  for (const id of START_PREFERENCE) {
    if (ids.has(id)) return id;
  }
  return installed[0]?.id ?? null;
}

/**
 * Whether the footer should show a chevron menu (need ≥2 installed CLIs).
 * @param {{ id: string }[]} installed
 */
export function showStartCliMenu(installed) {
  return (installed?.length ?? 0) > 1;
}

/**
 * Label for the primary Start button.
 * @param {string | null} startCli - resolved CLI id from pickStartCli
 * @param {{ id: string, displayName?: string }[]} installed
 */
export function startButtonLabel(startCli, installed) {
  if (!startCli) return "Start new session";
  const name =
    installed.find((p) => p.id === startCli)?.displayName ??
    providerById(startCli)?.displayName ??
    startCli;
  return `Start new ${name}`;
}

/**
 * Menu rows for installed CLIs, ordered by START_PREFERENCE ∩ installed.
 * @param {string | null | undefined} preferredCli - stored preference (may be uninstalled)
 * @param {{ id: string, displayName?: string }[]} installed
 * @returns {{ id: string, displayName: string, selected: boolean }[]}
 */
export function startMenuItems(preferredCli, installed) {
  const byId = new Map(installed.map((p) => [p.id, p]));
  const ordered = [];
  for (const id of START_PREFERENCE) {
    const p = byId.get(id);
    if (p) ordered.push(p);
  }
  for (const p of installed) {
    if (!ordered.some((o) => o.id === p.id)) ordered.push(p);
  }

  const effective = pickStartCli(preferredCli, installed);
  return ordered.map((p) => ({
    id: p.id,
    displayName: p.displayName ?? providerById(p.id)?.displayName ?? p.id,
    selected: p.id === effective,
  }));
}

/**
 * Full model for the Start footer control.
 * @param {string | null | undefined} preferredCli
 * @param {{ id: string, displayName?: string }[]} installed
 */
export function buildStartActionModel(preferredCli, installed) {
  const startCli = pickStartCli(preferredCli, installed);
  return {
    startCli,
    label: startButtonLabel(startCli, installed),
    showMenu: showStartCliMenu(installed),
    items: startMenuItems(preferredCli, installed),
  };
}
