# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for
anything exploitable.

- Preferred: use GitHub's **[Report a vulnerability](https://github.com/1ARdotNO/Jync/security/advisories/new)**
  (Security → Advisories) — private vulnerability reporting is enabled on this repo.
- We aim to acknowledge reports within a few days and to coordinate a fix and
  disclosure timeline with you.

Please include: affected version/commit, a description, reproduction steps, and
impact. Proof-of-concept code is welcome but never test against systems or data
you don't own.

## Supported versions

Jync is pre-1.0; only the latest `main` is supported. Fixes land on `main` and in
the next tagged release.

## Scope & handling notes

- **Credentials.** Jync currently authenticates to the JMAP backend over HTTP
  Basic and stores the credential in the plugin's `data.json`. Under a browser
  host (e.g. ignis) this may be plaintext on disk. Migrating to OAuth 2.0 bearer
  tokens is tracked on the roadmap. Treat a compromised vault/config directory as
  a credential exposure.
- **Data movement.** The plugin only syncs the configured sync-root subtree, and
  local deletes are disabled by default.
- **Automated hardening.** Dependencies and GitHub Actions are monitored by
  Dependabot alerts + Renovate; every change is gated by CI (build, integration
  tests, CodeQL, Trivy, MegaLinter) before merge.

## What is not a vulnerability

- Findings that require an already-compromised host or vault directory.
- Issues in a self-hosted JMAP backend (e.g. Stalwart) itself — report those upstream.
