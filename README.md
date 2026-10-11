# fieldsync

[![CI](https://github.com/mohdhafizi83/fieldsync/actions/workflows/ci.yml/badge.svg)](https://github.com/mohdhafizi83/fieldsync/actions/workflows/ci.yml)

An offline-first work-order app for field technicians, built with Expo (React Native) + TypeScript. The point of this repo is **the sync engine**, not UI polish: an append-only outbox with UUID idempotency keys, retry with exponential backoff + jitter, last-write-wins conflict resolution, and pull-based delta sync — all pure TypeScript, fully unit-tested with zero network access, and demonstrated live by a zero-credential demo.

```bash
npm install
npm run demo   # no emulator, no accounts, no network beyond 127.0.0.1
npm test       # 60 tests, all offline
```

## The problem

Field technicians work in basements, ship holds, and rural sites where connectivity is intermittent at best. A naive mobile app does one of two bad things when the radio drops: it blocks the UI until the server answers (unusable), or it fires writes into the void and hopes (data loss). When the connection returns, a second problem appears: the dispatcher may have edited the same work order meanwhile, and a naive client silently overwrites one side's work.

This app treats **the local device as the source of truth for the technician's session** and the server as the convergence point:

- Every mutation is written to local storage *and* appended to an outbox **before** any network call. Closing the app mid-outage loses nothing — un-acked mutations are replayed on next launch.
- Each mutation carries a **UUID idempotency key**, so a retry after a timeout (did the server process it or not?) can never double-apply.
- Conflicts are resolved by **last-write-wins on `updatedAt`**, with one refinement that matters in the field: a local edit that hasn't been acked yet is never silently overwritten by a pull — it wins until the server has seen it.

## Design notes

**Why an interface-separated store (`src/db/repository.ts`).** The sync engine only talks to a `WorkOrderRepository` interface. Production uses a `expo-sqlite` adapter; tests and the demo use an `InMemoryStore`; and the SQLite adapter is additionally tested against a fake driver that pattern-matches its SQL — so CI proves the adapter's wiring without ever needing native code. The engine is identical across all three.

**Why an append-only outbox.** Mutations are never removed, only marked `acked`. The log is simultaneously the retry queue, the crash-recovery record, and an audit trail ("what did the tech do at 14:32, and did the server ever see it?"). Flush order is the monotonic `seq`, so a create followed by an update always reaches the server in that order.

**Why LWW instead of a CRDT.** Honest trade-off. A CRDT (e.g. automerge, Yjs) merges concurrent edits field-by-field and never loses a keystroke — at the cost of a heavy dependency, opaque merge semantics, and a server that must store merge metadata. For work orders the conflicting fields are enums and short notes where "the most recent intentional edit wins" is the semantics the business actually wants, and the server's `updatedAt` is a single trustworthy clock. LWW with optimistic-concurrency checks (the server rejects a push whose `baseUpdatedAt` is stale with a 409) gives deterministic, explainable convergence in ~150 lines. If this product grew collaborative rich-text notes, I'd revisit per-field merging — for status flips and checklists, LWW is the right size.

**Why "local-pending-wins-until-acked".** Pure LWW on pull would let a slow reconnect clobber work the technician typed minutes ago (server clock newer, local edit un-acked). So `applyPulledRecord` checks the outbox: if there is an un-acked mutation for that entity, the local copy is kept; the conflict is then settled at push time, where the client rebases onto the server's clock and re-pushes. The demo transcript shows exactly this path.

**Why the mock server injects failures (`mock-server/`).** Retries and conflicts are the parts of a sync engine that are invisible when everything works. The mock has admin knobs for artificial latency, a bounded 503 outage window, and a server-side edit that is newer than anything the client holds. The demo uses them to force the engine through the retry path, the local-wins conflict path, and the server-wins path — live, in a transcript, rather than "trust my unit tests." (The unit tests also cover all of these with a scripted fake API.)

## Demo transcript (`npm run demo`)

Deterministic: the demo and the mock share one virtual clock, so every run prints this:

```
mock server up on http://127.0.0.1:4317 (20ms artificial latency, shared virtual clock)

========================================================================
1. Offline: technician works a job with no connection
========================================================================
  [01] ENQUEUE                      create wo-pump-01 queued (1 pending)
  [02] ENQUEUE                      update wo-pump-01 queued (2 pending)
  outbox: 2 pending mutations queued durably

========================================================================
2. Reconnect: first flush hits an injected 503 outage
========================================================================
  [03] PUSH_RETRY                   create wo-pump-01 failed (server error 503); retry in 15ms
  [04] PUSH_RETRY                   create wo-pump-01 failed (server error 503); retry in 30ms
  [05] PUSH_OK                      create wo-pump-01 acked (attempt 3)
  [06] PUSH_OK                      update wo-pump-01 acked (attempt 1)
  flush report: {"pushed":2,"conflicts":0,"retries":2,"failed":0} — backoff absorbed the outage

========================================================================
3. Outage clears: queue drains in order
========================================================================
  flush report: {"pushed":0,"conflicts":0,"retries":0,"failed":0} (already drained in step 2)

========================================================================
4. Conflict: dispatcher edits the same order while tech is mid-job
========================================================================
  [07] ENQUEUE                      update wo-pump-01 queued (1 pending)
  [08] PULL_CONFLICT_KEPT_LOCAL     kept local wo-pump-01 (un-acked edit wins until acked)
  [09] CURSOR_ADVANCED              delta cursor 0 -> 1760000060003
  [10] PUSH_CONFLICT_LOCAL_WINS     conflict on wo-pump-01: local newer, rebased & retrying
  [11] PUSH_OK                      update wo-pump-01 acked (attempt 2)
  sync report: pull={"applied":0,"deleted":0,"conflictsKeptLocal":1,"cursor":1760000060003} push={"pushed":1,"conflicts":1,"retries":0,"failed":0}

========================================================================
5. Second device: fresh install pulls everything via delta sync
========================================================================
  [12] PULL_APPLIED                 applied server change for wo-pump-01
  [13] CURSOR_ADVANCED              delta cursor 0 -> 1760000360001
  fresh device applied 1 record(s), cursor now 1760000360001

========================================================================
6. Idempotency: replaying an acked mutation is a server no-op
========================================================================
  replayed "uuid-create-001" — server changeLog 4 -> 4 entries (no double-apply)

========================================================================
Final state (server)
========================================================================
  wo-pump-01   done           Replace pump seal — seal replaced, tested OK — tech sign-off

demo complete — every mutation survived going offline, an outage, and a conflict.
```

## Layout

```
src/sync/        outbox.ts · backoff.ts · conflict.ts · engine.ts   (pure TS, zero RN imports)
src/db/          repository.ts (interface) · in-memory.ts · sqlite.ts (expo-sqlite adapter)
src/api/         client.ts — typed REST client over an injected fetch-like
src/screens/     WorkOrderList · WorkOrderDetail · SyncStatus (presentational, tested)
mock-server/     stdlib-only Node server: latency + failure + conflict injection, idempotency
scripts/demo.ts  the scripted scenario behind `npm run demo`
__tests__/       60 tests: outbox, backoff math, LWW cases, delta cursor, repo contract,
                 engine integration (scripted fake API), API client, 6 component tests
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run demo` | Full scripted scenario against the in-process mock — the proof artifact |
| `npm test` | 60 jest tests, zero network |
| `npm run typecheck` / `npm run lint` | tsc --noEmit / eslint |
| `npm run mock-server` | Standalone mock on :4000 (point `API_BASE` in `App.tsx` at it) |
| `npm start` | Expo app (three screens wired to the engine) |

CI (GitHub Actions, Node 20 + 22) runs install → typecheck → lint → jest → `expo export` (the real Metro bundle, no native toolchain needed).

## Honest limitations

- **Single-user per device, no push notifications.** Sync is pull/flush-on-demand; a real deployment would add FCM/APNs wake-ups and a background task to trigger flush.
- **LWW discards the loser's concurrent edit** (the demo shows the server-wins path). Field-level merging is the known upgrade path if the product needs it.
- **The outbox is in-memory in the demo**; the SQLite adapter persists work orders, but wiring outbox persistence to SQLite is left as the obvious next step (the interface is ready for it).
- **No auth.** The mock server is unauthenticated by design — it exists to demo sync, not security.
- The app screens are deliberately thin; the engine is the deliverable.

MIT © 2026 Mohd Hafizi
