# Setup guide

How to get Jync syncing your vault to a JMAP FileNode backend.

## 1. A JMAP FileNode server

You need a server that advertises `urn:ietf:params:jmap:filenode` and
`urn:ietf:params:jmap:blob`. [Stalwart](https://stalw.art) 0.16+ does, and also serves
your mail/calendar/contacts.

- **Try it locally:** `docker compose up -d` in this repo starts a Stalwart instance;
  `docker compose logs stalwart | grep -A2 password` prints the bootstrap admin password.
- **Existing server:** point Jync at your Stalwart origin (see step 3).

## 2. An account

Create (or use) an account on the server and note its credentials.

> **Do not sync with the admin credential.** Create a dedicated, least-privilege user.
> Jync supports two auth modes: **username + password** (HTTP Basic) or a **bearer token**
> (an OAuth access token or app token — preferred). Either way, **use `https://`** for any
> non-local server, since Basic credentials otherwise cross the wire in clear.

## 3. Install the plugin

**Recommended (beta): [BRAT](https://github.com/TfThacker/obsidian42-brat).** Install BRAT
from the community store, then *Add beta plugin* → `1ARdotNO/Jync` → enable **Jync** in
*Settings → Community plugins*. BRAT installs the latest release and auto-updates it.

Or build and install manually:

```bash
cd plugin
npm install
npm run build
```

Copy `manifest.json` (repo root) and `plugin/main.js` into
`<your-vault>/.obsidian/plugins/jync/`, then enable **Jync** in
*Settings → Community plugins*.

## 4. Configure

Open *Settings → Jync* and set:

| Field | Value |
|-------|-------|
| Server URL | your JMAP origin, e.g. `https://mail.example.com` |
| Authentication | *Username + password* or *Bearer token* (OAuth/app token — preferred) |
| Credentials | your dedicated account's password, or a scoped bearer token |
| Sync root | the vault folder to sync (only this subtree is touched) |
| Remote root folder | top-level folder name to create on the server |
| Ignore patterns | globs to exclude (e.g. `*.tmp`, `Excalidraw/`) |
| Conflict resolution | keep-both (default), prefer-local, or prefer-remote |

Click **Test connection** to verify the URL, credentials, and FileNode support, then
**Sync now**. Enable *Sync on change* and/or an auto-sync interval for hands-off syncing.

## Initial sync & adding devices

The **first sync** on any device performs a full two-way reconcile with whatever is
already on the server, so onboarding is safe in both directions:

- **First device (empty server):** your local notes are uploaded. Nothing to reconcile.
- **A new device with an *empty* sync-root folder:** the entire remote vault is
  **downloaded** to the new device.
- **A new device that already has a copy** of the notes (e.g. you copied the vault over):
  files are compared by content. Identical files are adopted with no transfer; files that
  **differ** on both sides are kept as a `… (remote conflict).md` copy — the local version
  stays in place and the remote version is saved alongside it. **Nothing is silently
  overwritten.**

After that first reconcile, each device syncs incrementally using the server's change feed.

**Recommended flow for a second device:** point Jync at the *same* server, username, and
**sync-root folder** as the first device, then Sync. If the new device's sync-root is empty,
you'll simply receive everything. If you want to avoid conflict copies entirely on a device
that already holds an older copy, either start it from an empty sync-root folder (let it
download), or set *Conflict resolution* to **prefer-remote** for the first sync.

## Running under ignis (browser Obsidian)

Jync runs unmodified inside [ignis](https://github.com/Nystik-gh/ignis). ignis proxies
plugin network requests server-side and blocks private hosts by default; to reach a
backend on a private address, allow-list it via `PROXY_ALLOW_PRIVATE_HOSTS` in the ignis
config. See [`CAPABILITIES.md`](./CAPABILITIES.md).

## Safety notes

- Local deletes are **off by default** — remote deletions won't remove local files unless
  you enable *Allow local deletes*.
- Concurrent edits on both sides produce a `… (remote conflict).md` copy; nothing is
  silently overwritten.
- Start with a **dedicated test folder** as the sync root before syncing your whole vault.
