import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { oneLine, isSafeSessionId } from "../src/lib/sanitize.js";
import { shellQuote } from "../src/lib/shell-quote.js";
import { buildResumeCommand, buildStartCommand } from "../src/lib/resume.js";
import { buildGroups, filterGroups } from "../src/lib/sessions/group.js";
import { relativeTime } from "../src/lib/time.js";

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

function thr_ms(minutes) {
  return minutes * 60 * 1000;
}
