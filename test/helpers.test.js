import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { oneLine, isSafeSessionId } from "../src/lib/sanitize.js";
import { shellQuote } from "../src/lib/shell-quote.js";
import { buildResumeCommand, buildStartCommand } from "../src/lib/resume.js";
import { buildGroups, filterGroups, groupByDate } from "../src/lib/sessions/group.js";
import { dateGroup, relativeTime } from "../src/lib/time.js";
import { PROVIDERS, providerById } from "../src/lib/sessions/providers.js";

describe("sanitize", () => {
  it("collapses whitespace and strips control chars", () => {
    assert.equal(oneLine("  hello\n\tworld\u0001  "), "hello world\uFFFD");
  });

  it("accepts UUIDs and rejects shell metacharacters", () => {
    assert.equal(isSafeSessionId("019fd37f-cc78-76c3-ba12-c5008005b813"), true);
    assert.equal(isSafeSessionId("abc;rm -rf /"), false);
    assert.equal(isSafeSessionId("short"), false);
  });
});

describe("shell-quote", () => {
  it("single-quotes and escapes", () => {
    assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  });
});

describe("resume commands", () => {
  const id = "019fd37f-cc78-76c3-ba12-c5008005b813";
  it("builds per-cli resume strings", () => {
    assert.match(buildResumeCommand("grok", id), /^grok --resume '/);
    assert.match(buildResumeCommand("claude", id), /^claude --resume '/);
    assert.match(buildResumeCommand("codex", id), /^codex resume '/);
    assert.match(buildResumeCommand("copilot", id), /^copilot --resume='/);
    assert.match(buildResumeCommand("cursor", id), /^cursor-agent --resume '/);
  });
  it("start commands", () => {
    assert.equal(buildStartCommand("grok"), "grok");
    assert.equal(buildStartCommand("cursor"), "cursor-agent");
  });
});

describe("group", () => {
  it("orders groups by latest session and omits empty", () => {
    const installed = [
      { id: "grok", displayName: "Grok" },
      { id: "claude", displayName: "Claude" },
      { id: "codex", displayName: "Codex" },
    ];
    const groups = buildGroups(
      installed,
      {
        grok: [{ id: "1", title: "g", updatedAt: 100, cli: "grok" }],
        claude: [{ id: "2", title: "c", updatedAt: 200, cli: "claude" }],
        codex: [],
      },
      {},
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[0].cli, "claude");
    assert.equal(groups[1].cli, "grok");
    assert.equal(filterGroups(groups, "grok").length, 1);
  });

  it("keeps error-only groups", () => {
    const groups = buildGroups(
      [{ id: "claude", displayName: "Claude" }],
      { claude: [] },
      { claude: "boom" },
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].error, "boom");
  });
});

describe("relativeTime", () => {
  it("formats recent times", () => {
    assert.equal(relativeTime(Date.now() -  thr_ms(0.5)), "just now");
    assert.match(relativeTime(Date.now() - thr_ms(5)), /5m ago/);
  });
});

describe("dateGroup", () => {
  it("returns Today for now", () => {
    assert.equal(dateGroup(Date.now()), "Today");
  });
  it("returns Yesterday for 1 day ago", () => {
    assert.equal(dateGroup(Date.now() - 86400000), "Yesterday");
  });
  it("returns Unknown for falsy input", () => {
    assert.equal(dateGroup(0), "Unknown");
  });
});

describe("groupByDate", () => {
  it("groups sessions by date label", () => {
    const sessions = [
      { id: "1", updatedAt: Date.now() },
      { id: "2", updatedAt: Date.now() },
      { id: "3", updatedAt: Date.now() - 86400000 },
    ];
    const groups = groupByDate(sessions, dateGroup);
    assert.equal(groups[0].label, "Today");
    assert.equal(groups[0].sessions.length, 2);
    assert.equal(groups[1].label, "Yesterday");
    assert.equal(groups[1].sessions.length, 1);
  });
});

function thr_ms(minutes) {
  return minutes * 60 * 1000;
};

describe("providers capabilities", () => {
  it("every provider has a capabilities object with rename/archive/delete booleans", () => {
    for (const p of PROVIDERS) {
      assert.ok(p.capabilities, `${p.id} missing capabilities`);
      assert.equal(typeof p.capabilities.rename, "boolean", `${p.id}.capabilities.rename`);
      assert.equal(typeof p.capabilities.archive, "boolean", `${p.id}.capabilities.archive`);
      assert.equal(typeof p.capabilities.delete, "boolean", `${p.id}.capabilities.delete`);
    }
  });

  it("archive is true for all providers", () => {
    for (const p of PROVIDERS) {
      assert.equal(p.capabilities.archive, true, `${p.id} should support archive`);
    }
  });

  it("grok supports rename and delete", () => {
    const grok = providerById("grok");
    assert.equal(grok.capabilities.rename, true);
    assert.equal(grok.capabilities.delete, true);
  });

  it("claude supports delete but not rename", () => {
    const claude = providerById("claude");
    assert.equal(claude.capabilities.rename, false);
    assert.equal(claude.capabilities.delete, true);
  });

  it("codex supports rename and archive but not delete", () => {
    const codex = providerById("codex");
    assert.equal(codex.capabilities.rename, true);
    assert.equal(codex.capabilities.archive, true);
    assert.equal(codex.capabilities.delete, false);
  });

  it("copilot only supports archive", () => {
    const copilot = providerById("copilot");
    assert.equal(copilot.capabilities.rename, false);
    assert.equal(copilot.capabilities.archive, true);
    assert.equal(copilot.capabilities.delete, false);
  });
});