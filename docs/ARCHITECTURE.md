# Architecture

How Jync moves bytes between an Obsidian vault and a JMAP FileNode backend.

## The data model

A **FileNode** is an inode-like object: a name + `parentId` (folder hierarchy) plus a
`blobId` pointing at content (or `null` for a directory). File content is uploaded
separately as a **blob** (JMAP core, RFC 8620) and then linked to a node. Stalwart
also exposes an explicit `nodeType` (`"file"` | `"directory"`) and allows **in-place
`blobId` updates**, so edits keep a stable node id.

```
vault/<syncRoot>/a/b.md      <->     FileNode: name=b.md, parentId=<a>, blobId=<blob>
vault/<syncRoot>/a/          <->     FileNode: name=a,   parentId=<root>, blobId=null
```

## The sync loop

Each `sync()` runs two directions against a persisted `SyncState`
(`{ rootNodeId, changesState, folders{}, files{} }`):

### 1. Pull (remote → local)
- `FileNode/changes` since `changesState` returns `{created, updated, destroyed}` id sets
  plus a new state token — a true incremental delta, no full re-scan.
- Changed file nodes are downloaded and written locally; destroyed nodes are removed
  (only if local deletes are enabled).

### 2. Push (local → remote)
- Walk the sync-root subtree, SHA-256 each file, compare to `files[path].hash`.
- New → upload blob + `FileNode/set create`. Changed → in-place `blobId` update.
  Missing locally → `FileNode/set destroy`.
- After push, the pull baseline (`changesState`) is advanced to the current server state,
  so the engine never re-pulls its own writes (no ping-pong).

## Conflict handling

A file changed on **both** sides since the last sync is detected during pull (remote
hash ≠ stored hash **and** local hash ≠ stored hash). Jync writes the remote version to
a sibling `… (remote conflict).md` copy and keeps the local edit (which then pushes up).
**No branch is ever silently overwritten.**

## Safety properties

- **Scoped** — only the configured sync-root subtree is ever touched.
- **Local deletes gated** — remote deletions do not remove local files unless explicitly enabled.
- **Idempotent** — a no-op sync is a no-op; re-attaching to a populated backend *adopts*
  existing nodes (`alreadyExists` → overwrite) instead of erroring.
- **Single-flight** — overlapping syncs are rejected, not interleaved.

## Running inside browser Obsidian (ignis)

The plugin is browser-safe: it uses Obsidian's `requestUrl` (not `fetch`) and web-crypto
(not Node `Buffer`). Under [ignis](https://github.com/Nystik-gh/ignis), `requestUrl` is
proxied server-side, so reaching a self-hosted backend requires allow-listing it past
ignis's SSRF guard. See [`CAPABILITIES.md`](./CAPABILITIES.md) for the ignis setup notes.

## Two deployment shapes

1. **Community plugin** — runs in the Obsidian client (desktop, mobile, or ignis browser).
2. **Server-side ignis plugin** — a headless variant modeled on ignis's `headless-sync`,
   syncing without an open tab. See the ignis section of [`FINDINGS.md`](./FINDINGS.md).
