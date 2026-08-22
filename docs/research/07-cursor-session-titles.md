# 07 — Cursor Agent session titles (`store.db`)

**Date:** 2026-08-22  
**Status:** research only (no scanner/manage code changes)  
**Primary evidence:** live `~/.cursor/chats/` on this machine; Cursor CLI cask `2026.08.11-e8db854` (`/opt/homebrew/Caskroom/cursor-cli/2026.08.11-e8db854/dist-package/`); official Cursor docs; this repo’s JS scanner.

Related: [RESEARCH.md](../../RESEARCH.md) dated section *Cursor Agent session titles (`store.db`) — 2026-08-22*.

---

## Summary: why Muxy shows `(untitled)`

Muxy’s Cursor scanner (`src/lib/sessions/scan/cursor.js`) reads only

`~/.cursor/chats/<md5(cwd)>/<session-id>/meta.json`

and takes `title` or `name`. If that file is missing or is not JSON (including truncated `readHead`), the row title is `(untitled)`.

On disk, **the authoritative store is `store.db`**, not `meta.json`. `meta.json` is an optional **sidecar cache** Cursor writes so `agent ls` / `/resume` can avoid opening SQLite. Most session directories never get a sidecar.

Additionally, Cursor **spawns subagents as sibling directories** under the same cwd hash. Those dirs almost always have:

- `store.db` only (no `meta.json`)
- metadata `name: "New Agent"`
- `subagentInfo` pointing at the parent UUID

Cursor’s own resume picker **drops** `isSubagent` and `!hasConversation` rows. Muxy lists every child directory. Combined with the sidecar-only title path, the panel fills with `(untitled)`.

### Live counts (this host, 2026-08-22)

| Item | Count |
|------|-------|
| CWD-hash roots under `~/.cursor/chats/` | 2 |
| Session directories (depth 2) | 25 |
| `store.db` | 24 |
| `meta.json` | 5 |
| `prompt_history.json` | 4 |
| Store `name === "New Agent"` | 20 / 24 |
| Store has `subagentInfo` | 20 / 24 (same 20) |
| Parent chats with human `name` + sidecar `title` | 4 |
| Empty sidecar, `hasConversation: false`, **no** `store.db` | 1 |

Identified hashes:

- `md5("/Users/gerlaca1/Projects/rust/smartsprayer-agronomic-service")` = `76e942f8bbf2776ec786e38f27dc6bad`
- `md5("/Users/gerlaca1/Projects/mc-daily-operational-reports")` = `f43523c681ce99eb0254bf4ff780b545`
- This repo’s cwd hash `c7c8eac72d1e1310739e86a9d64d9a97` has **no** chat dir (no local Cursor sessions for Muxy itself).

**Citations:** `find ~/.cursor/chats`; Python/sqlite probes of every `store.db`; `src/lib/sessions/scan/cursor.js` lines 38–60.

---

## 1. On-disk layout

### 1.1 Path

```
~/.cursor/chats/<md5(path.resolve(workspace))>/<uuid>/
```

Cursor CLI (`src/state/index.ts` in `3363.index.js`):

```js
function s() { return join(WI(), "chats"); }           // ~/.cursor/chats
function a(e) {
  const t = resolve(e);                                 // path.resolve
  const r = createHash("md5").update(t).digest("hex");
  return join(s(), r);
}
function d() { return a(process.cwd()); }
```

`create-chat` writes `join(r7(), uuid, "store.db")` with `r7()` = md5(cwd) chats dir (`4661.index.js`).

Muxy: `joinPath(home, ".cursor", "chats", md5Hex(cwd))` (`cursor.js`). Matches when `cwd` is an absolute resolved path.

ACP sessions are a **different** tree: `~/.cursor/acp-sessions/<id>/store.db` + `meta.json` (`2996.index.js`). Out of scope for the cwd-hash scanner.

### 1.2 Files per session

| File | Role |
|------|------|
| `store.db` | Authoritative KV + blob store (`sqlite-blob-store.js`) |
| `store.db-wal` / `store.db-shm` | WAL companions |
| `meta.json` | Sidecar for resume picker (`chat-session-sidecar.ts`) |
| `prompt_history.json` | Array of previous prompt strings (often starts with `/exit`); **not** used for titles |

### 1.3 SQLite schema

Observed on **all 24** local DBs and created by Cursor:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE IF NOT EXISTS meta  (key TEXT PRIMARY KEY, value TEXT);
```

**Citation:** `3363.index.js` sqlite-blob-store init; live `SELECT sql FROM sqlite_master`; `PRAGMA table_info(blobs|meta)`.

#### Table `blobs`

| Column | Type | Notes |
|--------|------|--------|
| `id` | TEXT PK | 64-char hex (SHA-256-length). Cursor hex-encodes blob ids (`nj`). |
| `data` | BLOB | UTF-8 JSON **or** binary DAG/protobuf |

#### Table `meta`

| Column | Type | Notes |
|--------|------|--------|
| `key` | TEXT PK | Always `"0"` for the session metadata document |
| `value` | TEXT | Lowercase **hex encoding of UTF-8 JSON** |

`sqlite3` `typeof(value)` = `text`, `substr(value,1,16)` starts `7b226167656e7449` = hex(`{"agentId`).

**Not** plain JSON text. `JSON.parse(value)` fails. Decode:

```
json = JSON.parse(Buffer.from(value, "hex").toString("utf8"))
```

Cursor: `serialize` = hex-codec of `JSON.stringify({ ...meta, latestRootBlobId: hex(bytes) })`; `deserialize` reverses (`index.js` class `U`).

### 1.4 Decoded meta JSON fields

Default object (`index.js`):

```js
{
  agentId: uuid,
  latestRootBlobId: Uint8Array,  // serialized as hex string
  name: "New Agent",
  mode: "default",               // default | plan | debug | search
  isRunEverything: false,
  approvalMode: undefined,       // allowlist | unrestricted | auto-review
  createdAt: Date.now(),         // ms (sometimes seconds — sidecar normalizes)
  lastUsedModel: undefined,
  lastDebugServerPort: undefined,
  currentPlanUri: undefined,
  subagentInfo: undefined,
  blobEncryptionKey: random32BytesAsHex64
}
```

Live field presence (24 DBs):

| Field | n |
|-------|---|
| `agentId`, `latestRootBlobId`, `name`, `mode`, `isRunEverything`, `createdAt`, `blobEncryptionKey` | 24 |
| `subagentInfo` | 20 |
| `lastUsedModel` | 4 |
| `approvalMode` | 3 |

`name` values: `"New Agent"` × 20; four human titles (`MC Health Summary`, `Implement Ticket DFITE`, `JWT OAuth Refactor`, `Implement DFITE Ticket`) — **exactly** the four parent sessions that also have sidecar `meta.json.title`.

`subagentInfo` shape:

```json
{
  "parentAgentId": "<uuid>",
  "rootParentAgentId": "<uuid>",
  "toolCallId": "call-…\nfc_…",
  "typeName": "generalPurpose"
}
```

`blobEncryptionKey`: string, length 64, `[0-9a-f]+`. **Do not log or persist.**

### 1.5 Sidecar `meta.json`

Built in `chat-session-sidecar.ts`:

```js
{
  schemaVersion,           // d.F4
  title: iq(name) ? name.trim() : undefined,  // omitted when "New Agent"
  createdAtMs,
  updatedAtMs,
  hasConversation: latestRootBlobId.length > 0,
  isSubagent: subagentInfo !== undefined ? true : omitted,
  cwd: optional
}
```

`iq` (`src/utils/terminal-title.ts`):

```js
const c = "New Agent";
function u(e) {
  return typeof e === "string" && e.trim().length !== 0 && e.trim() !== c;
}
```

Live sidecar **without** `title` (empty chat, no store): `hasConversation: false`.

Resume listing (`6260.index.js`):

```js
if (s.isSubagent) return;
if (!s.hasConversation) return;
name = sidecar.title ?? defaultStoreName  // TF()
```

Missing sidecar is **backfilled** from `store.db` (`DN()`), then written.

---

## 2. Transcript / first user message

### 2.1 How `blobs.data` is stored

| Kind | Magic / shape | Decode |
|------|----------------|--------|
| JSON message | starts with `{` (`hex 7B22…`) | UTF-8 JSON `{ role, content, … }` |
| DAG / protobuf | often `0a 20` + 32-byte id | **not** JSON/gzip/zlib; skip |
| Other | high entropy / mixed | skip |

Gzip `1f 8b`: **0** of sampled blobs. JSON messages were stored **unencrypted** on this machine.

`latestRootBlobId` refers to a **binary** blob, not the first user JSON.

Host `sqlite3 -json`:

- JSON blob → JSON string containing the message (usable if you `JSON.parse` the field).
- Binary blob → **lossy** Unicode (`\u00a2…`); length shrinks. Use `hex(data)` if you need bytes.

**Citation:** `/usr/bin/sqlite3 -readonly -json` against a live DB; Python `typeof(data)`.

### 2.2 First user blobs are weak titles

Every local DB’s first `role:"user"` JSON started with a system dump. Inner `<user_query>` held the real prompt.

Truncated examples (redacted):

| Kind | Start of `content` |
|------|---------------------|
| Parent user dump | `"<user_info>\nOS Version: darwin …\nWorkspace Path: /Users/…"` |
| Nested real prompt | `<user_query>/generate-mc-health-summary 1d</user_query>` |
| Subagent | `"<system_reminder>\nYou are running as a subagent under a parent agent."` |
| Subagent task | `You are the **datadog-analyzer** expert. Consultation mode: **Review**` |

Also seen: `<manually_attached_skills>`.

**Do not** use the first `role=user` blob raw as a title.

### 2.3 How to skip weak user messages

Suggested filters (research):

1. Only parse blobs whose `CAST(data AS TEXT)` starts with `{` and `json_valid`.
2. Require `role === "user"` (skip `system` / `assistant` / `tool`).
3. Flatten `content`: string, or `[{type:"text", text}]`.
4. If the body starts with `<user_info>`, `<system_reminder>`, `<manually_attached_skills>` (or other `<…>` dumps), extract `<user_query>…</user_query>` if present; else continue.
5. Reject leftover subagent briefs: `/^You are (running as a subagent|the \*?[\w-]+)/i`, “Plan-mode consultation”, “implementing ONE leaf ticket”.
6. Cap: first N JSON user blobs (e.g. 40) and max bytes per blob (e.g. 8–16 KiB via `substr`).

On this machine, **all 24** DBs had a nested `<user_query>` (parents: slash commands; subagents: delegated task text). That is **not** a guarantee for older/empty sessions.

### 2.4 Encryption key policy

`blobEncryptionKey` is generated locally (`crypto.getRandomValues` 32 bytes) and attached as request header `x-blob-encryption-key` (`blob-encryption-key-header.ts`). Local JSON transcripts were readable **without** it.

**Policy:** never copy the key into Muxy session rows, logs, or `meta.json` we write. If a future build encrypts `blobs.data`, degrade to sidecar/`name` only — do not ship a decryptor that stores the key.

---

## 3. Subagents vs resume list

`subagentInfo` **means this directory is a child agent**, not a user-started chat.

Cursor:

- Creates subagent stores with `setMetadata("subagentInfo", t)` (`3363.index.js` chatsDir factory).
- Resume picker: `if (s.isSubagent) return;`
- Changelog (2026-07-06): “Subagents keep their context across resumes”; drill-in from the parent UI, not as top-level `agent ls` rows.
- Docs: [CLI changelog](https://cursor.com/docs/cli/changelog) (March 2026 subagents; July 2026 resume). No user-facing schema docs.

**Should they appear in Muxy’s resume list?** **No** (not as peers). `cursor-agent --resume <subagent-uuid>` may still work (changelog: resuming a subagent restores context), but listing them as untitled sessions is how the panel becomes unusable. Optional later: nest under `parentAgentId`.

---

## 4. Official Cursor Agent CLI

**Binary:** `/opt/homebrew/bin/cursor-agent` → cask `2026.08.11-e8db854`. `cursor-agent --help` documents the `agent` command set. (Homebrew `agent` on this machine is **Grok**, not Cursor.)

| Interface | Title / session |
|-----------|-----------------|
| [cursor.com/docs/cli/overview](https://cursor.com/docs/cli/overview) | `agent ls`, `agent resume`, `agent --continue`, `agent --resume="chat-id-here"` |
| [cursor.com/docs/cli/using](https://cursor.com/docs/cli/using) | History: `--resume [thread id]`, `/resume`, `agent ls` |
| [cursor.com/docs/cli/reference/parameters](https://cursor.com/docs/cli/reference/parameters) | `--resume [chatId]`, `--continue` (= `--resume=-1`), commands `ls`, `resume`, `create-chat` |
| [cursor.com/docs/cli/reference/slash-commands](https://cursor.com/docs/cli/reference/slash-commands) | `/rename <name>` — “Rename the current chat session”; `/resume` |
| `cursor-agent --help` | `--resume [chatId]  Select a session to resume`; no `--name` |
| Forum [Want rename command with cli](https://forum.cursor.com/t/want-rename-command-with-cli/168920) (Kevin Neilson, 2026-08-20) | `/rename` shows in `agent ls`; no `agent --name` at launch |
| CLI source `/rename` | `agentStore.setMetadata("name", s)` — **store.db** |

There is **no** documented `meta.json` title field. The documented name is the **session name** (`/rename`), stored as store metadata `name`, mirrored to sidecar `title` when `iq(name)` passes.

No public `anysphere/cursor` GitHub tree for this SQLite format was found (2026-08-22 search).

---

## 5. This repo’s current behavior

### 5.1 Scan — `src/lib/sessions/scan/cursor.js`

1. `hash = md5Hex(cwd)`
2. `listDirDetailed(~/.cursor/chats/<hash>)`
3. `takeRecent(..., PER_GROUP_CAP + ENRICH_SLACK)` dirs
4. Per dir: `readHead(meta.json, maxBytes: 64000)`
5. `title = data.title || data.name || "(untitled)"`
6. timestamps: `updatedAtMs | updatedAt | updated_at`
7. `branch` from sidecar (Cursor sidecar **does not** write `branch`; Muxy’s field stays null)

No `store.db`. No `isSubagent` filter.

### 5.2 Rename — `src/lib/sessions/manage/index.js` `renameCursor`

Walks all hash dirs, finds `<id>/`, reads `meta.json` if present, sets `data.title = newTitle`, `writeAtomic`. **Does not** update `store.db` `meta` row `name`.

Cursor will **rewrite the sidecar from store `name`** on next open (`subscribeToMetadata("name")` in sidecar `j()`), wiping a Muxy-only title.

### 5.3 Copilot precedent

`isWeakTitle` / `pickDisplayTitle` / `firstUserMessageFromEvents` in `src/lib/sessions/scan/helpers.js`. Weak set: `""`, `(untitled)`, `untitled`, `session`, UUID, long hex. **`"New Agent"` is not weak today.**

### 5.4 Host sqlite

`src/lib/host-fs.js`: `sqliteQuery` → `/usr/bin/sqlite3 -readonly -json -- <db> <sql>`. `OPTIONAL_HOST_TOOLS = [sqlite3]`. Copilot already soft-fails when sqlite is missing (`COPILOT_SQLITE_SOFT_ERROR`).

### 5.5 Scan budget

`test/scan-budget.test.js`: `listCursor` with N=40 fixture **meta.json files**, asserts:

- no `/bin/cat`
- `head` ≤ `PER_GROUP_CAP + ENRICH_SLACK` (25+10)
- **total execs ≤ 50**

Adding one `sqlite3` per candidate (~35) **without** dropping `readHead` exceeds 50.

---

## 6. Practical title chain (recommendation, not implementation)

**Treat `"New Agent"` as a weak title: yes.** Cursor `iq()` and sidecar `g()` already do.

### Algorithm

```
for each recent dir under ~/.cursor/chats/<md5(cwd)>/<id>/:

  sidecar ← parse readHead(meta.json) if present

  if sidecar.isSubagent === true → skip (not a user resume row)
  if sidecar.hasConversation === false → skip

  storeMeta ← null
  if sqlite3 available AND (no sidecar OR weak sidecar.title OR need subagent/conversation flags):
      row ← sqliteQuery(store.db, "SELECT value FROM meta WHERE key = '0' LIMIT 1")
      storeMeta ← JSON.parse(utf8(fromHex(row.value)))
      // never copy storeMeta.blobEncryptionKey into the session row

  if storeMeta.subagentInfo → skip
  if storeMeta.latestRootBlobId is empty/missing AND sidecar.hasConversation !== true → skip

  title ← first strong among:
      1. sidecar.title
      2. sidecar.name          # Muxy historical write; Cursor uses title
      3. storeMeta.name
  where strong = !isWeakTitle(x) AND x.trim() !== "New Agent"

  if still weak AND sqlite3 AND not subagent (optional, budget-gated):
      title ← first real user_query / user text (filters in §2.3)

  if still weak → "(untitled)" or `Cursor · ${shortId(id)}`

  updatedAt ← sidecar.updatedAtMs || storeMeta.createdAt || dir mtime
```

### sqlite3 missing

Degrade: list using sidecar + mtime only; store-only dirs remain `(untitled)` (or hide them if we require sidecar `hasConversation` — that would hide most parents too, so **do not** hide merely for missing sidecar). Soft-warning analogous to Copilot is optional.

### Rename

**Yes, must write `store.db` as well as `meta.json`.**

1. `SELECT value FROM meta WHERE key='0'`
2. Hex-decode JSON; set `name` to the new title; **leave other keys untouched** (especially `blobEncryptionKey`, `agentId`, `subagentInfo`, `latestRootBlobId`)
3. Hex-encode JSON; `sqliteExec` `UPDATE meta SET value = … WHERE key = '0'` (not `-readonly`)
4. Upsert sidecar `meta.json`: `title`, keep `schemaVersion` / timestamps / `cwd` / `hasConversation` / `isSubagent`

WAL: update the main `store.db` via `sqlite3` (it checkpoints). Do not hand-edit `-wal`.

### Exec budget

Prefer:

- `readHead` sidecar first (already paid).
- `sqliteQuery` **only** when sidecar missing, title weak, or flags unknown.
- No blob scan on the hot list path (or only for the leftover weak parents after sqlite `name`).
- If always querying sqlite, drop redundant `readHead` **or** raise `listCursor`’s 50-exec cap in `scan-budget.test.js`.

---

## 7. Risks

| Risk | Mitigation |
|------|------------|
| `blobEncryptionKey` leakage | Never put it on the session DTO; redact in logs |
| Hex vs JSON confusion | Always `fromHex` then `JSON.parse` |
| `-json` binary blobs | `hex(data)` / `CAST AS TEXT` for JSON-only |
| Subagent clutter | Filter `subagentInfo` / `isSubagent` |
| Sidecar/store split on rename | Write both |
| Scan amplification | Gate sqlite/blob I/O; keep budget test honest |
| Format drift | Schema is CLI-private; wrap decode in try/catch |
| ACP vs chats | Do not mix `acp-sessions` into cwd lists |

---

## Citations index

| Claim | Source |
|-------|--------|
| Path `~/.cursor/chats/<md5(resolve(cwd))>/<uuid>/store.db` | CLI `3363.index.js` `src/state/index.ts`; live FS |
| Schema `blobs`/`meta` | CLI sqlite-blob-store CREATE TABLE; live `sqlite_master` |
| `meta.value` hex JSON, key `"0"` | live `typeof`/`substr`; CLI `INSERT … VALUES ('0', nj(serialize))` |
| Default `name: "New Agent"` | CLI `index.js` metadata constructor `J` |
| `"New Agent"` is not a real title | CLI `terminal-title.ts` `iq()` |
| `/rename` writes store `name` | CLI `6260.index.js` slash `setMetadata("name")`; [slash-commands](https://cursor.com/docs/cli/reference/slash-commands) |
| Sidecar skip subagent / empty | CLI `6260.index.js` listing + `chat-session-sidecar.ts` |
| Resume flags | [parameters](https://cursor.com/docs/cli/reference/parameters), `cursor-agent --help` |
| JSON `{role,content}` blobs | live `blobs.data` UTF-8 |
| `<user_info>` / `<system_reminder>` | live first user blobs (truncated above) |
| Encryption header, local JSON plaintext | `blob-encryption-key-header.ts`; live decode without key |
| Muxy scan/rename/budget | `src/lib/sessions/scan/cursor.js`, `manage/index.js` `renameCursor`, `host-fs.js` `sqliteQuery`, `test/scan-budget.test.js` |
| Copilot title chain | `src/lib/sessions/scan/helpers.js` `pickDisplayTitle` / `isWeakTitle` |
)
