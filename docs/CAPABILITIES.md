# Capabilities

What Jync supports and how each operation behaves.

## Sync operations

| Operation | Behavior |
|-----------|----------|
| **Create** | New local files and folders are uploaded and mirrored into the FileNode tree. |
| **Edit** | Content changes are pushed as an in-place `blobId` update — the node id stays stable. |
| **Delete** | Removing a local file destroys the corresponding remote node (opt-in for the reverse). |
| **Rename / move** | Reflected on the server; content is preserved across the move. |
| **Pull** | Remote creates, edits, and deletes flow down to the vault via `FileNode/changes`. |
| **Conflict** | A note edited on both sides keeps both — the remote copy lands as `… (remote conflict).md`. |

## File types

Markdown, plain text, JSON, Obsidian canvas, images and other binaries (PNG/JPG/PDF/…),
and large files all sync with byte-for-byte fidelity. Text and binary are handled uniformly
through JMAP blobs, so any file type in the sync root is supported.

## Behavioral guarantees

- **Scoped.** Only the configured sync-root subtree is ever touched.
- **Local deletes are opt-in.** Remote deletions do not remove local files unless you enable it.
- **No ping-pong.** The pull baseline advances past Jync's own writes each cycle.
- **Idempotent.** A no-op sync makes no changes.
- **Adoptive.** Pointing Jync at a backend that already holds your notes adopts the existing
  nodes rather than duplicating or erroring.

## Running under ignis (browser Obsidian)

Jync runs unmodified inside [ignis](https://github.com/Nystik-gh/ignis), which hosts Obsidian
in the browser. Two things to know for that setup:

- **Reaching a self-hosted backend.** ignis proxies plugin network requests server-side and
  blocks private hosts by default (SSRF protection). To reach a backend on a private address,
  allow-list it via `PROXY_ALLOW_PRIVATE_HOSTS` (e.g. `host.docker.internal` for a local
  Stalwart container) in the ignis server config.
- **Community plugins.** Enable community plugins in the vault so Jync loads, the same as any
  Obsidian plugin.

## Mobile

The plugin is built to run on Obsidian mobile (`isDesktopOnly: false`). It uses only
mobile-safe APIs — Obsidian's `requestUrl`, the vault `DataAdapter`, and web-standard
`crypto.subtle` / `btoa` / `TextEncoder` — with **no** Node built-ins (`fs`, `Buffer`,
`child_process`) or Electron/`FileSystemAdapter` calls. `crypto.subtle` (used for content
hashing) requires a secure context, which Obsidian mobile provides. No desktop-only
dependencies are present; on-device testing is recommended before relying on it.

## Try it

```bash
docker compose up -d                      # local Stalwart with FileNode
cd e2e && node run.mjs sync               # run a sync via headless browser Obsidian
JYNC_PASS=… node ../scripts/remote.ts list  # inspect the FileNode tree on the server
```
