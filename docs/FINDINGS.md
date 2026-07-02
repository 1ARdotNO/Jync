# Jync — design notes

Why Jync is built on JMAP FileNode, and the Stalwart-specific details that shape the
sync engine. Reference notes for contributors; see [`ARCHITECTURE.md`](./ARCHITECTURE.md)
for the runtime design and [`CAPABILITIES.md`](./CAPABILITIES.md) for supported behavior.

## Why JMAP FileNode works for vault sync

JMAP FileNode gives an Obsidian plugin everything it needs — a folder tree, blob-backed
content, and an incremental change feed. Against **Stalwart 0.16.11**
(`urn:ietf:params:jmap:filenode` + `:blob`):

## The FileNode building blocks

| Step | Method | Result |
|------|--------|--------|
| Discovery | `GET /jmap/session` | `filenode` + `blob` advertised; `mayCreateTopLevelFileNode: true` |
| Upload note body | `POST /jmap/upload/{accountId}/` | returns `{blobId, type, size}` |
| Create folder + file | `FileNode/set` (create) | folder = collection, file links `blobId` |
| Read tree | `FileNode/get`, `FileNode/query` | full metadata; `canCalculateChanges: true` |
| Download body | `GET /jmap/download/...` | content round-trips intact |
| **Edit in place** | `FileNode/set` (update `blobId`) | **node id preserved** across edits |
| **Incremental sync** | `FileNode/changes` | `{created, updated, destroyed}` + state tokens |

## Stalwart specifics (differ from / extend the IETF draft)

- **Explicit `nodeType`** property (`"directory"` \| `"file"`) in addition to the
  draft's "blobId == null ⇒ collection" convention. Either works.
- **In-place content mutation is allowed.** The draft implies `blobId`/`size`/`type`
  are immutable post-creation (⇒ destroy+recreate on edit). Stalwart exposes
  `mayModifyContent: true` and accepts `update: { id: { blobId, size } }`, keeping
  the node id stable. **Use this** — it makes the sync model much cleaner.
- Richer `myRights`: `mayAddChildren`, `mayModifyContent` beyond draft's read/write/share.
- Extra node fields: `target` (symlink?), `changed`, `accessed`, `isSubscribed`, `role`.
- FileNode capability declares constraints to respect client-side:
  `maxSizeFileNodeName: 255`, `forbiddenNameChars: "/<>:\"\\|?*"`,
  forbidden names (`.`, `..`, `CON`, `PRN`, `COM1`…), `caseInsensitiveNames: false`.
- Timestamps (`modified`/`accessed`) are **client-managed** — the server won't
  auto-touch them, so Jync sets them for conflict ordering.

## Gotcha discovered

Within a single `FileNode/set`, JMAP runs **create before destroy** (per RFC 8620).
Recreating a file with the same name as one you're destroying in the *same* call
collides (name conflict) and the create silently lands in `notCreated`. Either do
in-place `update` (preferred) or split destroy/create across two calls.

## Auth note

The plugin authenticates with HTTP Basic today; the JMAP account model supports
OAuth 2.0 bearer tokens (Stalwart included), which is the intended direction — with a
dedicated per-user account rather than the admin credential.

## Compatibility with ignis (Nystik-gh/ignis)

[ignis](https://github.com/Nystik-gh/ignis) runs Obsidian in the browser with the
vault stored on the server. Jync is compatible, and there are **two ways to ship it**.

### Path A — Jync as a normal Obsidian plugin (runs inside ignis's browser Obsidian)

Works, because Jync only needs the Vault API + HTTP, both of which ignis supports.
No Node native modules / `child_process` / streaming zlib (the things ignis can't do).
Constraints:

- **Use Obsidian `requestUrl`, not raw `fetch`.** From the browser tab, calls to
  Stalwart are cross-origin → CORS. ignis proxies `requestUrl`/`fetch` through its
  server, sidestepping CORS. (The plugin uses `requestUrl` + `btoa`/`TextEncoder`; the
  standalone Node client in `src/` uses `fetch`+`Buffer`.)
- **Token storage is plaintext under ignis** (`safeStorage` is passthrough). Prefer
  short-lived OAuth bearer tokens over storing a password.
- **Multi-tab races.** ignis syncs live across tabs; a per-tab Jync loop would race on
  `FileNode/set`. Needs single-flight / leader election.

### Path B — Jync as an ignis *server-side* plugin (mirrors `headless-sync`) — preferred

ignis already ships a server-side `headless-sync` plugin that runs Obsidian Sync
headlessly via the `ob` CLI:
`apps/ignis-server/server/plugins/headless-sync/` — `register(ctx)` entrypoint,
`SyncManager` (spawns/tracks per-vault sync, persists `sync-states.json`),
`SyncBroadcaster` (pushes status over `ctx.wss` WebSocket), `auth.js` (token in
`ctx.dataDir`), and `core-sync-guard` (stops the browser's core Sync from conflicting).

Jync could be a **sibling server plugin following the same shape**, swapping the
`ob`-CLI/Obsidian-Sync backend for our JMAP FileNode client. This is *architectural
pattern reuse, not code reuse* — `headless-sync` is hardwired to `ob` + Obsidian Sync
tokens, so we'd reimplement the manager/broadcaster around JMAP.

Why it's the nicer fit:

- **Headless** — syncs even with no browser tab open (the whole point of ignis's
  headless-sync), so no multi-tab race.
- **Full Node runtime server-side** — real `fetch`/`Buffer`/`fs`, direct file watching
  of the vault dir, no CORS. Our `src/jmap.ts` runs basically as-is.
- Single process ⇒ one sync engine, natural single-flight.

Open questions / caveats:

- ignis's server plugin API (the `ctx` shape: `dataDir`, `wss`, `getEnabledVaults`,
  `config.getVaultPath`) is **not a documented/stable public API** — `index.js` has a
  `TODO: add server plugin manifest`. Building against it means tracking ignis internals.
- **Two sync engines on one vault dir** (headless Obsidian Sync + Jync/JMAP) would
  conflict. Pick one, or extend the `core-sync-guard` idea to coordinate them.
- Reuse the `SyncBroadcaster` WebSocket so the browser UI can show Jync status the same
  way it shows Obsidian Sync status (status bar plugin already exists).

**Takeaway:** for an ignis-centric deployment, build Jync as a server-side ignis plugin
modeled on `headless-sync`; keep the browser-plugin path (A) for plain desktop/mobile
Obsidian. The JMAP client core (`src/jmap.ts`) is shared by both.
