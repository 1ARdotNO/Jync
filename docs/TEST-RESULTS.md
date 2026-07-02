# Jync plugin — integration test results

Validated the Obsidian plugin end-to-end **inside the running ignis stack**
(browser Obsidian → ignis `requestUrl` proxy → Stalwart JMAP FileNode), driven by
headless Chromium (`e2e/run.mjs`). All JMAP traffic confirmed flowing through
ignis `POST /api/proxy`.

## Environment
- Stalwart 0.16.11 (`jync-stalwart`), JMAP on host :8091.
- [ignis](https://github.com/Nystik-gh/ignis) serving a test vault at :8082 (browser Obsidian).
- Sync scope: **a single subfolder only** inside the vault — a large vault is NOT
  wholesale-synced (deliberate safety scoping; sync root is a setting).

## Integration hurdles solved
1. **ignis proxy SSRF guard.** `requestUrl` is proxied server-side; the proxy blocks
   private hosts. Fixed by allow-listing `host.docker.internal` (192.168.65.254) via
   `PROXY_ALLOW_PRIVATE_HOSTS` in `apps/ignis-server/docker-compose.override.yml`.
   Plugin server URL is therefore `http://host.docker.internal:8091`.
2. **Restricted mode.** Fresh browser sessions boot with the plugin system off;
   the harness calls `app.plugins.setEnable(true)` before loading Jync.
3. **Pre-existing remote nodes.** Push now adopts (`alreadyExists` → overwrite) so
   sync is idempotent against a non-empty backend.

## Operations verified (all through the browser)

| Operation | Result |
|-----------|--------|
| CREATE (md, txt, json, canvas, **binary png**, nested folders, 48 KB file) | 8/8 pushed, 0 errors |
| Content integrity | every local sha256 == remote sha256, **incl. binary pixel.png** |
| EDIT | in-place `blobId` update, node id preserved |
| DELETE | local delete → remote `FileNode/set destroy` |
| RENAME | old destroyed + new created, content preserved (same sha) |
| PULL (remote→local) | `FileNode/changes` delta: remote edit + remote-new both applied locally |
| CONFLICT (both sides edit) | safe `... (remote conflict).md` copy, **zero data loss** |
| Idempotency | immediate re-sync = all zeros (no ping-pong) |
| Re-adoption | wiped local state, re-synced → 9 nodes adopted, 0 errors |

## How to re-run
```bash
# stack: docker compose up (stalwart) ; ignis already running
cd jync/e2e && node run.mjs sync                       # one sync via browser
JYNC_PASS=… node ../scripts/remote.ts verify           # authoritative remote check
JYNC_PASS=… node ../scripts/remote.ts reset            # wipe remote Jync/ for a clean run
```

## Known follow-ups (not blockers)
- Auth is HTTP Basic w/ admin creds in plaintext `data.json` — swap for OAuth bearer + a
  dedicated user before real use.
- Rename is delete+recreate (re-uploads content); could use FileNode name/parentId update.
- Sync is full-subtree scan each run; fine for a folder, add mtime fast-path for big trees.
