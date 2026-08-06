/**
 * Palette command entry: multi-provider session resume modal.
 * Built to a single IIFE via esbuild (see copy-manifest.mjs).
 * runScript context — muxy.* is mostly synchronous; host-fs is thenables-aware.
 */

import { createHostFs, ensureHostTools, hasSqlite3, chain } from "../src/lib/host-fs.js";
import { listSessionsJs } from "../src/lib/sessions/scan/index.js";
import { isSafeSessionId } from "../src/lib/sanitize.js";
import { toPromise } from "../src/lib/sessions/scan/helpers.js";

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

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
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

/**
 * Sync-friendly list: host-fs chain returns plain values when exec is sync.
 * Scanners are async functions — we drive them with a tiny sync pump by
 * resolving only non-promise values... Actually async functions always
 * return Promises. For runScript we need either top-level await or a
 * blocking wait. Muxy runScript supports returning a Promise from the
 * script in recent hosts; we use async IIFE.
 */
async function listAllSessions(cwd, installed) {
  const exec = (argv, options) => muxy.exec(argv, options);
  const toolsOk = await toPromise(ensureHostTools(exec));
  if (!toolsOk) {
    throw new Error(
      "Host tools (cat, ls, stat, …) are required to read CLI session stores",
    );
  }
  const fs = createHostFs(exec);
  let sqliteAvailable = true;
  try {
    sqliteAvailable = Boolean(await toPromise(hasSqlite3(exec)));
  } catch {
    sqliteAvailable = false;
  }

  const items = [];
  for (let i = 0; i < installed.length; i++) {
    const provider = installed[i];
    try {
      const rows = await listSessionsJs(fs, provider.id, cwd, { sqliteAvailable });
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

async function main() {
  const cwd = activeCwd();
  if (!cwd) {
    muxy.notifications.notify({
      title: "AI Sessions",
      body: "No active project folder",
    });
    return;
  }
  const installed = detectInstalled();
  if (!installed.length) {
    muxy.notifications.notify({
      title: "AI Sessions",
      body: "No AI CLIs found on PATH",
    });
    return;
  }
  let items;
  try {
    items = await listAllSessions(cwd, installed);
  } catch (e) {
    muxy.notifications.notify({
      title: "AI Sessions",
      body: e?.message || String(e),
    });
    return;
  }
  if (!items.length) {
    muxy.notifications.notify({
      title: "AI Sessions",
      body: "No resumable sessions for this folder",
    });
    return;
  }
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

// Kick off; swallow rejection into notification.
const _run = main();
if (_run && typeof _run.then === "function") {
  _run.catch(function (e) {
    try {
      muxy.notifications.notify({
        title: "AI Sessions",
        body: e?.message || String(e),
      });
    } catch (err) {
      /* ignore */
    }
  });
}

// silence unused
void chain;
