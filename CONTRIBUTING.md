# Contributing to Jync

Thanks for your interest! Jync is a young project; issues and PRs are welcome.

## Project layout

| Path | What |
|------|------|
| `plugin/` | The Obsidian plugin — `src/jmap.ts` (client), `src/sync.ts` (engine), `src/paths.ts` (pure helpers), `src/main.ts` (plugin + settings) |
| `src/` | Standalone Node JMAP client + example scripts (`roundtrip.ts`, `probe-edit.ts`) |
| `scripts/remote.ts` | Server-side helper to inspect/reset the FileNode tree |
| `e2e/run.mjs` | Headless-browser harness that drives the plugin inside Obsidian |
| `docs/` | Architecture, capabilities, design notes, security review |

## Dev setup

```bash
# JMAP backend for local testing
docker compose up -d
docker compose logs stalwart | grep -A2 password

# plugin
cd plugin && npm install && npm run build   # or `npm run dev` for watch mode

# repo-level tooling (lint / typecheck / unit tests)
npm install            # in repo root
npm run lint
npm run typecheck
npm run test:unit
```

## Tests

- **Unit tests** (`plugin/test/**/*.test.mjs`, `npm run test:unit`) — pure logic
  (name validation, ignore globs, mime mapping). Add cases here when you touch
  `plugin/src/paths.ts` or other pure helpers. CI runs `npm run test:coverage`,
  which enforces a coverage floor on `paths.ts` (lines ≥90, branches ≥85, funcs ≥90),
  so keep those helpers well covered.
- **Integration** (`src/roundtrip.ts`, `src/probe-edit.ts`) — exercise the real JMAP
  protocol against a Stalwart service container (run in CI).
- **End-to-end** (`e2e/run.mjs`) — drives the plugin inside headless-browser Obsidian.

Please add or update tests with behavioral changes, especially anything touching the
sync engine or the security-sensitive path handling (see [`docs/SECURITY-REVIEW.md`](./docs/SECURITY-REVIEW.md)).

## CI & merging

Every PR must pass the blocking checks: **build** (lint + typecheck + unit tests +
plugin build), **test** (Stalwart integration), **CodeQL**, **MegaLinter**, and **Trivy**.
`main` is protected; dependency updates are automerged by Renovate once green.

## Conventions

- TypeScript, ESLint (`npm run lint` must pass). Keep the plugin **browser-safe** — no Node
  built-ins (`fs`, `Buffer`, `child_process`); use Obsidian APIs (`requestUrl`, the vault
  adapter) and web-standard globals.
- Prefer small, focused PRs with a clear description.
- Report security issues privately — see [`SECURITY.md`](./SECURITY.md).
