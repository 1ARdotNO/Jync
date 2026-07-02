# Jync — Security Review & Remediation Handoff

**Reviewer:** 1ar (security engineer)
**Date:** 2026-07-02
**Scope reviewed:** shipped plugin — `plugin/src/jmap.ts`, `plugin/src/sync.ts`, `plugin/src/main.ts`
**Method:** code review (OWASP A01–A10) + STRIDE on the plugin↔JMAP-server boundary.
**Not reviewed:** standalone Node client in `src/`, `scripts/remote.ts`, `e2e/`, live Stalwart.

---

## TL;DR for the implementer

Jync is a client that treats the **JMAP server as fully trusted**. Every finding below is a
consequence of that assumption failing — a compromised/malicious Stalwart, a multi-tenant
server where another account can write into your tree, or a man-in-the-middle (realistic,
because the **default transport is plaintext HTTP**).

Fix in this order:

- [x] **1 — HIGH:** Path traversal on pull → arbitrary vault write → RCE. *(sync.ts)*
- [x] **2 — MEDIUM:** Auth header sent to server-controlled URLs → credential exfiltration. *(jmap.ts)*
- [x] **3 — MEDIUM:** Plaintext HTTP is the default; no TLS enforcement. *(main.ts / jmap.ts)*
- [x] **4 — MEDIUM:** Plaintext credential storage + default `admin` account. *(main.ts)* — partial
- [x] **5 — LOW:** Server-advertised name/size constraints unenforced. *(sync.ts / jmap.ts)* — names done; size cap roadmap

Finding 1 is the one that matters most — it's a client-side RCE, and findings 2–3 make its
trigger easier to reach. Fixing 1 + 5 together is natural (both are "validate server-supplied
names/sizes").

## Remediation status (2026-07-02)

| # | Fix landed | Where |
|---|-----------|-------|
| 1 | `safeSegment()` rejects traversal/illegal names in `remotePath()`; `writeLocal()` refuses any path outside the sync root | `plugin/src/sync.ts` |
| 2 | `connect()` pins `apiUrl`/`uploadUrl`/`downloadUrl` to the configured origin; refuses cross-origin credential sends | `plugin/src/jmap.ts` |
| 3 | `isInsecureUrl()` drives a settings warning + a sync-time console warning for plain-HTTP non-local hosts | `plugin/src/main.ts` |
| 4 | Default `username` empty (no `admin` nudge); **bearer-token auth added** — use an OAuth access/app token instead of Basic. **Remaining:** interactive OAuth sign-in + non-plaintext token storage | `plugin/src/main.ts`, `plugin/src/paths.ts` |
| 5 | Name constraints enforced via `safeSegment()`. **Remaining:** blob-size ceiling (roadmap) | `plugin/src/sync.ts` |

Residual items: interactive OAuth device-flow sign-in and non-plaintext token storage
(F4), and a blob-size cap (F5). TLS *enforcement* for F3 is deferred in favor of the
bearer-token direction now available.

---

## 1 — [HIGH] Path traversal on pull → arbitrary vault write → RCE

**Where:** `plugin/src/sync.ts`
- `remotePath()` — lines 151–168 (builds a path from server-controlled `node.name`)
- `writeLocal()` — lines 143–148 (writes it to disk)
- conflict-copy write — line 228 (same server-derived `rel`)

**Problem.** The plugin builds a local path by concatenating server-controlled `node.name`
values and writes the downloaded blob there, with **no validation of the names**:

```ts
// remotePath(): parts are raw server-supplied names
parts.push(node.name);                       // sync.ts:163
// ...
// writeLocal():
const abs = normalizePath(this.cfg.syncRoot + "/" + rel);   // sync.ts:144
await this.adapter.writeBinary(abs, buf);                    // sync.ts:147
```

Obsidian's `normalizePath()` normalizes slashes and Unicode but **does not resolve `..`
segments**. So a remote node named `..` (or a name containing `../`) yields, e.g.,
`rel = "../../.obsidian/plugins/evil/main.js"`, which the `FileSystemAdapter` resolves against
the **vault root**, escaping `syncRoot` entirely.

The pull path does **not** skip dotfiles (the dotfile skip at `sync.ts:81` is push-only), so
nothing stops a write into `.obsidian/`. Writing `.obsidian/plugins/<x>/main.js` gives
**code execution in the Obsidian process on next load** — full client compromise.

The server even advertises the constraints that would prevent this
(`forbiddenNameChars: "/<>:\"\\|?*"`, reserved names `.`/`..`, `maxSizeFileNodeName: 255`;
see `docs/FINDINGS.md:36`) — but the plugin never enforces them.

**Fix.** Sanitize every remote name segment, and defensively confine the resolved path to
`syncRoot`. Two layers:

```ts
// (a) reject bad segments where the remote path is assembled (remotePath, ~line 160):
const FORBIDDEN_CHARS = /[/\\<>:"|?*\x00-\x1f]/;   // server forbiddenNameChars + control chars
const RESERVED = /^(\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function safeSegment(name: string): boolean {
  return !!name
    && name.length <= 255
    && !FORBIDDEN_CHARS.test(name)
    && !RESERVED.test(name.replace(/\.+$/, "")) // trailing-dot names too
    && name !== "." && name !== "..";
}
// in remotePath(), before parts.push(node.name):
if (!safeSegment(node.name)) return null;   // treat as "not under our root" -> skipped

// (b) containment guard in writeLocal() (belt-and-braces):
private async writeLocal(rel: string, buf: ArrayBuffer): Promise<void> {
  const root = normalizePath(this.cfg.syncRoot);
  const abs = normalizePath(root + "/" + rel);
  if (abs !== root && !abs.startsWith(root + "/")) {
    throw new Error(`refusing write outside syncRoot: ${rel}`);
  }
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  if (dir && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
  await this.adapter.writeBinary(abs, buf);
}
```

Apply the **same containment guard** to the conflict-copy write at `sync.ts:228` (it builds
`cpath` from the same server-derived `rel`) and to the delete path at `sync.ts:197` (a
traversing `rel` there could target a file outside the root for deletion when
`allowLocalDeletes` is on).

**Refs:** OWASP A01 / A08; CWE-22 (Path Traversal), CWE-73.

**Verify:** with a test JMAP server, return a FileNode named `..` (or `../evil`) and confirm
the write is refused (previously it would land in `.obsidian/` or the vault root). See the
PoC suggestion at the end.

---

## 2 — [MEDIUM] Auth header sent to server-controlled URLs (credential exfiltration)

**Where:** `plugin/src/jmap.ts` — `connect()` line 100; `request()`/`uploadBlob()`/
`downloadBlobBinary()` lines 114–155; `abs()` lines 56–58.

**Problem.** The `/jmap/session` response fully controls `apiUrl`, `uploadUrl`, and
`downloadUrl`. The client stores it verbatim (`this.session = res.json`, line 100) and then
sends `Authorization: Basic <creds>` to whatever those URLs point at — including a **different
origin**. `abs()` only prefixes *relative* paths, so an absolute attacker URL
(`https://attacker.example/...`) passes straight through. One rogue session response
exfiltrates the Stalwart credentials.

**Fix.** Pin the endpoint origins to the configured `baseUrl` origin after `connect()`:

```ts
async connect(): Promise<JmapSession> {
  const res = await this.req({ url: this.base + "/jmap/session", headers: { Authorization: this.auth } });
  if (res.status !== 200) throw new Error(`session ${res.status}: ${res.text?.slice(0, 200)}`);
  const s = res.json as JmapSession;
  const baseOrigin = new URL(this.base).origin;
  for (const [k, u] of Object.entries({ apiUrl: s.apiUrl, uploadUrl: s.uploadUrl, downloadUrl: s.downloadUrl })) {
    // uploadUrl/downloadUrl are templates; strip {placeholders} before parsing
    const probe = u.replace(/\{[^}]+\}/g, "x");
    const abs = probe.startsWith("http") ? probe : this.base + probe;
    if (new URL(abs).origin !== baseOrigin) {
      throw new Error(`JMAP ${k} origin ${new URL(abs).origin} != ${baseOrigin}; refusing to send credentials cross-origin`);
    }
  }
  this.session = s;
  return this.session;
}
```

**Refs:** OWASP A10 / A02; CWE-346 (Origin Validation Error), CWE-522.

---

## 3 — [MEDIUM] Plaintext HTTP is the default; no TLS enforcement

**Where:** `plugin/src/main.ts:14` (`baseUrl: "http://localhost:8091"`); `plugin/src/jmap.ts:56–58` (`abs()` accepts any `http://`).

**Problem.** Auth is HTTP Basic, so on any non-loopback `http://` deployment the
`username:password` (base64) crosses the wire in cleartext — sniffable and MITM-able. A MITM
also upgrades finding **1** from "trust your server" to "trust your network."

**Fix.** Warn or refuse when `baseUrl` is `http://` and the host is **not** `localhost`/
`127.0.0.1`. Surface an explicit "insecure transport" state in the settings UI, and prefer the
OAuth-bearer direction already noted in `docs/FINDINGS.md:48`.

```ts
function isInsecure(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch { return true; }
}
// in the settings tab, show a warning callout when isInsecure(s.baseUrl);
// optionally block runSync() with a Notice unless the user explicitly opts in.
```

**Refs:** OWASP A02; CWE-319 (Cleartext Transmission).

---

## 4 — [MEDIUM] Plaintext credential storage + default `admin` account

**Where:** `plugin/src/main.ts:16` (`username: "admin"`); `main.ts:136` (password persisted via `saveData`); `main.ts:135` (settings desc already admits plaintext under ignis).

**Problem.** `password` is written to the plugin's `data.json` in cleartext. The default
`username: "admin"` nudges users to sync with the Stalwart **admin** credential, so a leak is
full-server rather than a single mailbox.

**Fix.**
- Make OAuth bearer / scoped token the primary auth path (per `docs/FINDINGS.md:48`).
- Change the default `username` to `""` (empty) so there's no "use admin" nudge.
- Document: *"create a dedicated per-user account with a scoped token; never sync with the
  admin credential."*
- On desktop, consider Electron `safeStorage` for the secret (note it's passthrough under
  ignis, so this is desktop-only hardening — don't rely on it as the sole control).

**Refs:** OWASP A02 / A05; CWE-256, CWE-312 (Cleartext Storage).

---

## 5 — [LOW] Server-advertised name/size constraints unenforced

**Where:** `plugin/src/sync.ts` (pull path); `plugin/src/jmap.ts:144` (`downloadBlobBinary` — unbounded).

**Problem.** `downloadBlobBinary` has no size ceiling — an oversized remote blob can exhaust
disk/memory (local DoS). Reserved/illegal/over-length names produce un-writable paths or
cross-platform breakage. Same root cause as finding 1: server data used unchecked.

**Fix.** Enforce the advertised FileNode constraints (`maxSizeFileNodeName`,
`forbiddenNameChars`, reserved names — largely covered by the `safeSegment()` helper in
finding 1) and cap accepted blob size with a configurable ceiling (e.g. reject/skip blobs over
a settings-defined limit, logging the skip rather than silently truncating).

**Refs:** OWASP A04 (Insecure Design); CWE-400, CWE-20.

---

## What's already done well (don't regress these)

- **Single-flight guard** on sync (`sync.ts:58,356`) + `syncing` flag (`main.ts:90`) — no in-client concurrent runs.
- **Local deletes off by default** (`allowLocalDeletes`), clearly labelled DANGER — destructive direction is opt-in.
- **Conflict-safe merge** — concurrent edits produce a `(remote conflict)` copy, never a silent overwrite (`sync.ts:226–231`); content diffed by SHA-256, not timestamps.
- **`encodeURIComponent`** on the download URL `name`/`type` templating (`jmap.ts:149–150`) — extend that same distrust to the write path (finding 1).
- **Retry/backoff with jitter**, honours `Retry-After` (`jmap.ts:82–92`).

---

## Suggested verification (PoC)

The cleanest way to prove finding 1 (and then prove the fix closes it) is a tiny hostile JMAP
server in `e2e/`:

1. Serve `/jmap/session` advertising `filenode` + `blob`, with `apiUrl`/`uploadUrl`/
   `downloadUrl` on the same origin.
2. On `FileNode/changes` + `FileNode/get`, return one node whose `name` is `..` chained to
   `.obsidian/plugins/jync-poc/main.js` (or simplest: a single node named `../PWNED.md`).
3. Point a test vault's Jync at it and run a pull.

**Before fix:** a file appears outside `syncRoot` (vault root or `.obsidian/`).
**After fix:** the write is refused with `refusing write outside syncRoot` and the node is skipped.

Do this only against a throwaway local vault — it's an arbitrary-write test.
