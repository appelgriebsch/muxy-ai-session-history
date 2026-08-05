/** Canonical provider registry (Muxy-aligned ids). */

export const PROVIDERS = [
  { id: "grok", displayName: "Grok", binary: "grok", binaries: ["grok"] },
  { id: "claude", displayName: "Claude", binary: "claude", binaries: ["claude"] },
  { id: "codex", displayName: "Codex", binary: "codex", binaries: ["codex"] },
  { id: "copilot", displayName: "Copilot", binary: "copilot", binaries: ["copilot"] },
  {
    id: "cursor",
    displayName: "Cursor",
    binary: "cursor-agent",
    binaries: ["cursor-agent", "cursor"],
  },
];

/** Preference order for "Start new" when preferredCli is missing. */
export const START_PREFERENCE = ["grok", "claude", "codex", "copilot", "cursor"];

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}
