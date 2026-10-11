# Security Policy

## Scope

This repository is a **client application** (Expo/React Native) plus a sync
engine in pure TypeScript, and a **dev-only mock server**. What is in scope
and what is not:

| In scope | Out of scope |
| --- | --- |
| The sync engine (`src/sync/`) and API client (`src/api/`) | The production backend — it does not exist in this repo |
| The dev-only mock server (`mock-server/`) | Any deployment of the mock server (see below — never deploy it) |
| CI/CD supply chain (`.github/workflows/`, pinned deps) | Physical device security, OS-level issues |

## The production assumption

The sync engine **assumes HTTPS and server-side authentication/authorization
in production**. The client code in this repo:

- speaks plain REST over an injected `fetch` — TLS termination, certificate
  validation, auth headers/tokens, and per-user authorization are the
  responsibility of whatever backend and transport configuration you put in
  front of it;
- stores work orders locally (SQLite via `expo-sqlite`). On a real device,
  that data is only as protected as the OS sandbox — if the workload demands
  it, encrypt at rest (e.g. SQLCipher) before shipping real customer data;
- keeps no credentials in the repo and logs no tokens or secrets (there are
  none to log — the demo is zero-credential by design).

## The mock server is dev-only. Never deploy it.

`mock-server/server.js` has **no authentication, no TLS, and no rate
limiting**, and its `/admin/*` endpoints let anyone change its state. It is
mitigated for local use — it binds to `127.0.0.1` only, caps request bodies
at 1 MiB, bounds request timeouts, and returns generic error bodies with no
stack traces — but those are hygiene measures for a demo on your own machine,
not a security boundary. Do not expose it on a network, put it behind a proxy,
or reuse it as a production starting point.

## What the idempotency keys do — and do not — protect

Every mutation carries a UUIDv4 key generated from a CSPRNG
(`crypto.getRandomValues`, with a `node:crypto` fallback and **no
`Math.random` path** — generation fails loudly rather than emit a weak key).

They **do** protect against *accidental double-apply*: if a push times out and
the client retries, the server dedupes on the key and replays the original
result instead of applying the mutation twice. This is a correctness property
for the retry path.

They **do not** provide:

- **authentication or authorization** — the keys are not secrets and are not
  credentials. Anyone who can reach the API and guesses or observes a key can
  replay that mutation; a production server must authorize the caller before
  honoring any push, regardless of key.
- **integrity or non-repudiation** — the keys sign nothing.
- **protection against malicious replay by an attacker** — dedupe is bounded
  by the server's memory of seen keys (in the mock: process lifetime only).

## CI supply chain

- GitHub Actions are pinned to full commit SHAs (tags in comments).
- Direct npm dependencies are pinned to exact versions; `npm ci` installs
  from the lockfile.
- CI runs a dependency-audit gate (`scripts/audit-gate.mjs`: fails on any
  fixable high/critical advisory) and gitleaks secret scanning on every push
  and PR.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/mohdhafizi83/fieldsync/security/advisories/new)
on the repository. Expect a response within 7 days. Given the scope above,
reports about the mock server's lack of auth or about the absent production
backend are known design decisions, not vulnerabilities — but if you find a
way the *client or sync engine itself* loses data, leaks information, or can
be made to misbehave, that is worth a report.
