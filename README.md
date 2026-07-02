<div align="center">

# ⚡ Jync

### Sync your Obsidian vault over **JMAP** — the protocol your mail server already speaks.

*Change-driven. Self-hosted. Conflict-safe. Runs even in browser-based Obsidian.*

</div>

---

Most self-hosted Obsidian sync bolts onto WebDAV or S3 and **polls-and-diffs** your whole
vault to guess what changed. Jync takes a different path: it talks **JMAP FileNode** to a
backend like [Stalwart](https://stalw.art) and asks the server one question —

> *"What changed since state `X`?"*

The server answers with an exact delta. No scanning the world. No guessing. Just the diff.

And because a JMAP server like Stalwart already serves your **mail, calendar, and
contacts**, your notes live right next to them. One server. One protocol. One backup.

## ✨ Features

- 🔁 **True incremental sync** — driven by `FileNode/changes` state tokens, not directory polling.
- 🧠 **Bidirectional** — edits flow both ways: local→remote *and* remote→local.
- 🛟 **Conflict-safe by design** — edit the same note in two places and you get a
  `… (remote conflict).md` copy, **never** a silent overwrite.
- 📦 **Any file type** — markdown, canvas, JSON, images, PDFs, large files — content is
  synced byte-for-byte.
- 🌳 **Scoped & safe** — sync one folder or the whole vault; local deletes are **off by default**.
- ♻️ **Idempotent** — a no-op sync does nothing, and pointing Jync at a backend that already
  has your notes *adopts* them instead of duplicating.
- 🌐 **Browser-ready** — 100% browser-safe (`requestUrl` + web-crypto), so it runs on desktop,
  mobile, and inside [ignis](https://github.com/Nystik-gh/ignis) browser Obsidian alike.
- 🪶 **Lightweight core** — the JMAP client is plain TypeScript on native primitives, no heavy deps.

## 🚀 Quick start

```bash
# 1. Spin up a JMAP backend (or point Jync at an existing Stalwart server)
docker compose up -d
docker compose logs stalwart | grep -A2 password      # grab the admin password

# 2. Build the Obsidian plugin
cd plugin && npm install && npm run build
#    → drop manifest.json (repo root) + main.js into <vault>/.obsidian/plugins/jync/ and enable it
```

**Or install the beta with [BRAT](https://github.com/TfThacker/obsidian42-brat)** (no build needed):
install BRAT from the community store → *Add beta plugin* → enter `1ARdotNO/Jync` → enable **Jync**
in *Settings → Community plugins*. BRAT tracks each new release automatically.

Open **Settings → Jync**, enter your server URL and credentials, pick a **sync-root folder**,
and hit sync. That's it.

## 🎬 Conflict-safe sync in action

```text
[jync] push new  meeting-notes.md
[jync] push new  diagram.canvas
[jync] push new  screenshot.png
[jync] pull update roadmap.md
[jync] CONFLICT — kept both: roadmap.md and "roadmap (remote conflict).md"
[jync] sync done {pulled: 2, pushedNew: 8, pushedEdit: 1, deletedRemote: 0, conflicts: 1}
```

Edit a note on your laptop and your phone before they sync, and Jync keeps **both** versions —
your work is never silently clobbered.

## 🧭 How it works

```
        pull: FileNode/changes since <token>          push: hash-diff the subtree
   ┌───────────────────────────────────────┐   ┌───────────────────────────────────┐
   │  remote creates / edits / deletes  ──► │   │ ──► upload blob + create/update    │
   │  applied to the vault                  │   │     or destroy on the server       │
   └───────────────────────────────────────┘   └───────────────────────────────────┘
```

Content rides on JMAP blobs; a `FileNode` links name + parent + blob. The pull baseline
advances past your own writes each cycle, so nothing ping-pongs. Full design in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## 📚 Documentation

| Doc | What's inside |
|-----|---------------|
| 🚀 [`docs/SETUP.md`](./docs/SETUP.md) | Step-by-step: server, account, install, configure |
| 📐 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | The FileNode model, the two-way sync loop, conflict handling, and safety guarantees |
| 📋 [`docs/CAPABILITIES.md`](./docs/CAPABILITIES.md) | Supported operations, file types, and behavior; plus running under ignis |
| 🔬 [`docs/FINDINGS.md`](./docs/FINDINGS.md) | Design notes: why JMAP FileNode, Stalwart specifics, and the ignis integration paths |
| 🔐 [`docs/SECURITY-REVIEW.md`](./docs/SECURITY-REVIEW.md) | OWASP/STRIDE review + remediation status |

Contributing? See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Reporting a vulnerability? [`SECURITY.md`](./SECURITY.md).

## 🗂️ Repository layout

| Path | What |
|------|------|
| `plugin/` | The Obsidian plugin — browser-safe client, sync engine, settings |
| `src/` | Standalone Node JMAP client + example scripts (`roundtrip.ts`, `probe-edit.ts`) |
| `scripts/remote.ts` | Server-side helper: inspect / reset the FileNode tree |
| `e2e/run.mjs` | Headless-browser harness for driving the plugin inside Obsidian |
| `docker-compose.yml` | Local Stalwart with FileNode enabled |

## 🚦 Status

Jync is pre-1.0 and under active development toward the Obsidian community store. Known
limitations on the roadmap:

- 🔐 Authentication supports HTTP Basic or a bearer token (OAuth access/app token); interactive OAuth sign-in is planned.
- ✏️ Rename re-uploads content instead of moving the node in place.
- 📈 Push rescans the sync-root each cycle (an mtime fast-path is planned for very large vaults).
- 📄 JMAP FileNode is an IETF draft (`draft-ietf-jmap-filenode`); the wire format may still change.

Contributions and issues welcome.

## 📄 License

[MIT](./LICENSE)
