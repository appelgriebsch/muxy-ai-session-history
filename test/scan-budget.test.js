import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostFs } from "../src/lib/host-fs.js";
import { listGrok } from "../src/lib/sessions/scan/grok.js";
import { listClaude } from "../src/lib/sessions/scan/claude.js";
import { listCodex } from "../src/lib/sessions/scan/codex.js";
import { pathQuote, slugify, PER_GROUP_CAP } from "../src/lib/sessions/scan/helpers.js";
import { countingExec } from "./helpers/counting-exec.js";

const PROJ = "/tmp/muxy-budget-proj";
const N = 40;

function realExec(argv, opts = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    input: opts.stdin,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 20000,
    env: process.env,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

function uuidAt(i) {
  const hex = i.toString(16).padStart(12, "0");
  return `aaaaaaaa-aaaa-aaaa-aaaa-${hex}`;
}

describe("scan exec budgets (amplification)", () => {
  let home;
  let prevHome;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "scan-budget-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("listGrok N=40 stays under budget and returns PER_GROUP_CAP", async () => {
    const root = join(home, ".grok", "sessions", pathQuote(PROJ));
    for (let i = 0; i < N; i++) {
      const sid = uuidAt(i);
      const sess = join(root, sid);
      mkdirSync(sess, { recursive: true });
      writeFileSync(
        join(sess, "summary.json"),
        JSON.stringify({
          generated_title: `Grok ${i}`,
          updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
          info: { id: sid },
        }),
      );
      // Distinct mtimes for ranking
      const t = new Date(2026, 0, 1, 0, 0, i);
      utimesSync(sess, t, t);
    }

    const exec = countingExec(realExec);
    const fs = createHostFs(exec);
    const rows = await listGrok(fs, PROJ, { home });
    assert.equal(rows.length, PER_GROUP_CAP);
    // listDir + batched stat + at most cap+slack readText (no per-child isDir/isFile/mtime)
    assert.ok(
      exec.calls.length <= 50,
      `expected ≤50 execs, got ${exec.calls.length}`,
    );
  });

  it("listClaude with many foreign jsonl only enriches capped set", async () => {
    const base = join(home, ".claude");
    const projects = join(base, "projects");
    const expected = join(projects, slugify(PROJ));
    mkdirSync(expected, { recursive: true });

    for (let i = 0; i < N; i++) {
      const sid = uuidAt(i);
      const path = join(expected, `${sid}.jsonl`);
      writeFileSync(
        path,
        JSON.stringify({
          type: "user",
          message: { content: `msg ${i}` },
          cwd: PROJ,
        }) + "\n",
      );
      const t = new Date(2026, 0, 1, 0, 0, i);
      utimesSync(path, t, t);
    }

    // Foreign project with many jsonl that should not all be head-read
    const foreign = join(projects, "other-project");
    mkdirSync(foreign, { recursive: true });
    for (let i = 0; i < N; i++) {
      const sid = uuidAt(1000 + i);
      writeFileSync(
        join(foreign, `${sid}.jsonl`),
        JSON.stringify({
          type: "user",
          message: { content: "foreign" },
          cwd: "/tmp/other",
        }) + "\n",
      );
    }

    const exec = countingExec(realExec);
    const fs = createHostFs(exec);
    const rows = await listClaude(fs, PROJ, { home, claudeConfigDir: base });
    assert.equal(rows.length, PER_GROUP_CAP);

    const headCalls = exec.countWhere((a) => a[0] === "/usr/bin/head");
    // Only cap+slack heads, not N*2 projects
    assert.ok(
      headCalls <= PER_GROUP_CAP + 15,
      `expected ≤${PER_GROUP_CAP + 15} head calls, got ${headCalls}`,
    );
    assert.ok(
      exec.calls.length <= 60,
      `expected ≤60 total execs, got ${exec.calls.length}`,
    );
  });

  it("listCodex file fallback ranks before reading all rollouts", async () => {
    const codexHome = join(home, ".codex");
    const sessions = join(codexHome, "sessions", "2026", "01");
    mkdirSync(sessions, { recursive: true });
    for (let i = 0; i < N; i++) {
      const sid = uuidAt(i);
      const name = `rollout-2026-01-01T00-00-${String(i).padStart(2, "0")}-${sid}.jsonl`;
      const path = join(sessions, name);
      writeFileSync(
        path,
        JSON.stringify({
          type: "session_meta",
          payload: { id: sid, cwd: PROJ, source: "cli" },
        }) + "\n",
      );
      const t = new Date(2026, 0, 1, 0, 0, i);
      utimesSync(path, t, t);
    }

    const exec = countingExec(realExec);
    const fs = createHostFs(exec);
    const rows = await listCodex(fs, PROJ, {
      home,
      codexHome,
      sqliteAvailable: false,
    });
    assert.equal(rows.length, PER_GROUP_CAP);
    const headCalls = exec.countWhere((a) => a[0] === "/usr/bin/head");
    assert.ok(
      headCalls <= PER_GROUP_CAP + 15,
      `expected capped head calls, got ${headCalls}`,
    );
  });
});
