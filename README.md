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
contacts**, your notes come home to live right next to them. One server. One protocol.
One backup.

## ✨ Features

- 🔁 **True incremental sync** — powered by `FileNode/changes` state tokens, not directory polling.
- 🧠 **Bidirectional** — edits flow both ways: local→remote *and* remote→local.
- 🛟 **Conflict-safe by design** — edit the same note in two places? You get a
  `… (remote conflict).md` copy, **never** a silent overwrite.
- 📦 **Every file type** — markdown, canvas, JSON, images, PDFs, big files — verified byte-exact.
- 🌳 **Scoped & safe** — sync one folder or the whole vault; local deletes are **off by default**.
- ♻️ **Idempotent** — a no-op sync does nothing; re-attaching to an existing backend
  *adopts* what's there instead of exploding.
- 🌐 **Browser-ready** — 100% browser-safe (`requestUrl` + web-crypto), so it even runs
  inside [ignis](https://github.com/Nystik-gh/ignis) browser Obsidian.
- 🪶 **Zero-dependency core** — the JMAP client is plain TypeScript on native primitives.

## 🚀 Quick start

```bash
# 1. Spin up a local JMAP backend
docker compose up -d
docker compose logs stalwart | grep -A2 password      # grab the admin password

# 2. Prove the protocol end-to-end (no dependencies)
JYNC_PASS=<password> node src/roundtrip.ts

# 3. Build the Obsidian plugin
cd plugin && npm install && npm run build
#    → drop manifest.json + main.js into <vault>/.obsidian/plugins/jync/ and enable it
```

Point it at your server, pick a **sync-root folder**, and hit sync. That's it.

## 🎬 What it looks like

```text
[jync] push new  big.md
[jync] push new  board.canvas
[jync] push new  pixel.png
[jync] pull update welcome.md
[jync] CONFLICT — wrote remote copy to welcome (remote conflict).md
[jync] sync done {pulled: 2, pushedNew: 8, pushedEdit: 1, deletedRemote: 0, conflicts: 1}
```

Every one of those operations has been run through **real browser Obsidian → Stalwart**
with content verified byte-for-byte. The receipts are in the docs. 👇

## 📚 Documentation

| Doc | What's inside |
|-----|---------------|
| 📐 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | The FileNode model, the two-way sync loop, conflict handling, and safety guarantees |
| 🔬 [`docs/FINDINGS.md`](./docs/FINDINGS.md) | Feasibility research: why JMAP FileNode works, Stalwart quirks, and the ignis integration paths |
| ✅ [`docs/TEST-RESULTS.md`](./docs/TEST-RESULTS.md) | Full end-to-end validation of every sync operation through browser Obsidian |

## 🧭 How it works (the 10-second version)

```
        pull: FileNode/changes since <token>          push: hash-diff the subtree
   ┌───────────────────────────────────────┐   ┌───────────────────────────────────┐
   │  remote creates / edits / deletes  ──► │   │ ──► upload blob + create/update    │
   │  applied to the vault                  │   │     or destroy on the server       │
   └───────────────────────────────────────┘   └───────────────────────────────────┘
```

Content rides on JMAP blobs; a `FileNode` links name + parent + blob. Full details in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## 🗂️ Repository layout

| Path | What |
|------|------|
| `src/` | Dependency-free Node JMAP client + de-risking scripts (`roundtrip.ts`, `probe-edit.ts`) |
| `plugin/` | The Obsidian plugin — browser-safe client, sync engine, settings |
| `scripts/remote.ts` | Server-side helper: inspect / reset / verify the FileNode tree |
| `e2e/run.mjs` | Headless-browser harness driving the plugin inside Obsidian |
| `docker-compose.yml` | Local Stalwart with FileNode enabled |

## 🚦 Status & honest caveats

Jync is a **working prototype** — every sync operation is implemented and verified
end-to-end — but it is **not production-hardened yet**:

- 🔐 Auth is HTTP Basic and credentials sit in the plugin's `data.json`. Move to OAuth 2.0
  bearer tokens + a dedicated account before trusting it with real data.
- ✏️ Rename is delete + recreate (re-uploads content) rather than a metadata move.
- 📈 Push scans the full sync-root each run; a large tree wants an mtime fast-path.
- 📄 JMAP FileNode is an IETF draft (`draft-ietf-jmap-filenode`) — the wire format may shift.

Contributions and issues welcome.

## 📄 License

[MIT](./LICENSE)
