/**
 * Palette command: multi-provider session resume modal.
 * runScript context — muxy.* is mostly synchronous.
 *
 * At build time, copy-manifest.mjs replaces the placeholder below with the
 * base64-encoded scan-sessions.cjs so the picker does not depend on install path.
 */

const SCANNER_SOURCE_B64 = "__SCANNER_SOURCE_B64__";

const PROVIDERS = [
  { id: "grok", displayName: "Grok", binaries: ["grok"] },
  { id: "claude", displayName: "Claude", binaries: ["claude"] },
  { id: "codex", displayName: "Codex", binaries: ["codex"] },
  { id: "copilot", displayName: "Copilot", binaries: ["copilot"] },
  { id: "cursor", displayName: "Cursor", binaries: ["cursor-agent", "cursor"] },
];

const RESUME = {
  grok: (id) => "grok --resume " + shellQuote(id),
  claude: (id) => "claude --resume " + shellQuote(id),
  codex: (id) => "codex resume " + shellQuote(id),
  copilot: (id) => "copilot --resume=" + shellQuote(id),
  cursor: (id) => "cursor-agent --resume " + shellQuote(id),
};

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SESSION_ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z._-]{5,128}$/;

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function isSafeSessionId(id) {
  if (typeof id !== "string" || !id) return false;
  if (UUID_RE.test(id)) return true;
  return SESSION_ID_RE.test(id) && !/[\s;'"`$|<>]/.test(id);
}

function relativeTime(ms) {
  if (!ms) return "";
  const delta = Date.now() - ms;
  if (delta < 0) return "just now";
  const sec = Math.floor(delta / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 48) return hr + "h ago";
  const day = Math.floor(hr / 24);
  if (day < 30) return day + "d ago";
  return Math.floor(day / 30) + "mo ago";
}

function activeCwd() {
  try {
    const worktrees = muxy.worktrees.list();
    const wt = worktrees.find(function (w) {
      return w.isActive;
    });
    if (wt && wt.path) return wt.path;
  } catch (e) {
    /* ignore */
  }
  const projects = muxy.projects.list();
  const active = projects.find(function (p) {
    return p.isActive;
  });
  return active ? active.path : null;
}

function detectInstalled() {
  const installed = [];
  for (let i = 0; i < PROVIDERS.length; i++) {
    const provider = PROVIDERS[i];
    for (let j = 0; j < provider.binaries.length; j++) {
      const name = provider.binaries[j];
      try {
        const result = muxy.exec(["bash", "-lc", "command -v " + name], {
          timeoutMs: 5000,
        });
        const path = String(result.stdout || "").trim();
        const code = result.exitCode != null ? result.exitCode : result.code;
        if (code === 0 && path) {
          installed.push(provider);
          break;
        }
      } catch (e) {
        /* try next */
      }
    }
  }
  return installed;
}

function decodeScanner() {
  if (!SCANNER_SOURCE_B64 || SCANNER_SOURCE_B64.indexOf("__SCANNER") === 0) {
    return null;
  }
  try {
    // JavaScriptCore may lack atob in some contexts — use manual base64 if needed
    if (typeof atob === "function") {
      return atob(SCANNER_SOURCE_B64);
    }
  } catch (e) {
    /* fall through */
  }
  // Manual base64 decode (ASCII scanner source)
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const str = SCANNER_SOURCE_B64.replace(/=+$/, "");
  let out = "";
  for (let i = 0; i < str.length; i += 4) {
    const a = chars.indexOf(str.charAt(i));
    const b = chars.indexOf(str.charAt(i + 1));
    const c = chars.indexOf(str.charAt(i + 2));
    const d = chars.indexOf(str.charAt(i + 3));
    const n = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
    out += String.fromCharCode((n >> 16) & 255);
    if (c !== -1 && str.charAt(i + 2) !== "") out += String.fromCharCode((n >> 8) & 255);
    if (d !== -1 && str.charAt(i + 3) !== "") out += String.fromCharCode(n & 255);
  }
  return out;
}

function scanCli(cli, cwd, scannerSource) {
  const result = muxy.exec(["node", "-", cli, cwd], {
    timeoutMs: 20000,
    stdin: scannerSource,
  });
  const text = String(result.stdout || "").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const lines = text.split("\n").filter(Boolean);
    parsed = JSON.parse(lines[lines.length - 1]);
  }
  if (parsed && parsed.error) throw new Error(String(parsed.error));
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

function listAllSessions(cwd, installed, scannerSource) {
  const items = [];
  for (let i = 0; i < installed.length; i++) {
    const provider = installed[i];
    try {
      const rows = scannerSource ? scanCli(provider.id, cwd, scannerSource) : [];
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        if (!row || !isSafeSessionId(row.id)) continue;
        items.push({
          id: provider.id + ":" + row.id,
          title: String(row.title || "(untitled)").replace(/\s+/g, " ").slice(0, 120),
          subtitle: [
            provider.displayName,
            relativeTime(Number(row.updatedAt) || 0),
            row.branch || "",
          ]
            .filter(Boolean)
            .join(" · "),
          _updatedAt: Number(row.updatedAt) || 0,
        });
      }
    } catch (e) {
      /* skip provider */
    }
  }
  items.sort(function (a, b) {
    return (b._updatedAt || 0) - (a._updatedAt || 0);
  });
  return items.slice(0, 80);
}

const cwd = activeCwd();
if (!cwd) {
  muxy.notifications.notify({
    title: "AI Sessions",
    body: "No active project folder",
  });
} else {
  const installed = detectInstalled();
  if (!installed.length) {
    muxy.notifications.notify({
      title: "AI Sessions",
      body: "No AI CLIs found on PATH",
    });
  } else {
    const scannerSource = decodeScanner();
    if (!scannerSource) {
      muxy.notifications.notify({
        title: "AI Sessions",
        body: "Scanner not embedded — run npm run build and reload the extension",
      });
    } else {
      const items = listAllSessions(cwd, installed, scannerSource);
      if (!items.length) {
        muxy.notifications.notify({
          title: "AI Sessions",
          body: "No sessions for this folder",
        });
      } else {
        muxy.modal.open({
          placeholder: "Resume AI session…",
          items: items.map(function (item) {
            return { id: item.id, title: item.title, subtitle: item.subtitle };
          }),
          onSelect: function (choice) {
            if (!choice) return;
            const parts = String(choice.id).split(":");
            if (parts.length < 2) return;
            const cli = parts[0];
            const sessionId = parts.slice(1).join(":");
            if (!isSafeSessionId(sessionId) || !RESUME[cli]) return;
            muxy.tabs.open({
              kind: "terminal",
              directory: ".",
              command: RESUME[cli](sessionId),
            });
          },
        });
      }
    }
  }
}
