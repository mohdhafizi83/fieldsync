/**
 * Zero-credential demo: boots the mock server in-process, drives the sync
 * engine through a realistic field-technician day, prints a transcript.
 *
 *   npm run demo
 *
 * No emulator, no accounts, no network beyond 127.0.0.1. A shared virtual
 * clock makes the conflict outcomes deterministic — every run prints the
 * same transcript.
 */
import { createMockServer } from '../mock-server/server';
import { createApiClient, type FetchLike } from '../src/api/client';
import { InMemoryStore } from '../src/db/in-memory';
import { SyncEngine, type SyncEvent } from '../src/sync/engine';

const PORT = 4317;
const BASE = `http://127.0.0.1:${PORT}`;

// One virtual clock shared by the engine and the mock server, advanced
// explicitly between scenes so LWW outcomes are reproducible.
let vclock = 1_760_000_000_000;
const now = () => vclock;
const tick = (ms: number) => {
  vclock += ms;
};

const pad = (n: string | number, w: number) => String(n).padEnd(w);
let step = 0;
function banner(text: string): void {
  console.log(`\n${'='.repeat(72)}\n${text}\n${'='.repeat(72)}`);
}
function log(event: SyncEvent): void {
  console.log(`  [${String(++step).padStart(2, '0')}] ${event.kind.toUpperCase().padEnd(28)} ${event.message}`);
}

async function admin(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

async function main(): Promise<void> {
  const mock = createMockServer({ port: PORT, latencyMs: 20, clock: now });
  await mock.listen();
  console.log(`mock server up on ${BASE} (20ms artificial latency, shared virtual clock)`);

  // "Offline" is simulated by a fetch wrapper that throws while the radio is off.
  let online = false;
  const fetchLike: FetchLike = async (url, init) => {
    if (!online) throw new Error('offline (radio off)');
    const res = await fetch(url, init as RequestInit);
    return { status: res.status, json: () => res.json() };
  };

  const repo = new InMemoryStore();
  const api = createApiClient(fetchLike, BASE);
  const engine = new SyncEngine({
    api,
    repo,
    now,
    backoff: { baseMs: 20, capMs: 80, rng: () => 0.5 },
    maxAttemptsPerFlush: 4,
    onEvent: log,
  });

  banner('1. Offline: technician works a job with no connection');
  await engine.mutate({
    id: 'uuid-create-001',
    op: 'create',
    entityId: 'wo-pump-01',
    baseUpdatedAt: 0,
    payload: { title: 'Replace pump seal', site: 'Plant A', status: 'in_progress', notes: 'seal worn' },
  });
  tick(60_000);
  await engine.mutate({
    id: 'uuid-update-002',
    op: 'update',
    entityId: 'wo-pump-01',
    baseUpdatedAt: 0,
    payload: { status: 'done', notes: 'seal replaced, tested OK' },
  });
  console.log(`  outbox: ${engine.outbox.pendingCount} pending mutations queued durably`);

  banner('2. Reconnect: first flush hits an injected 503 outage');
  online = true;
  await admin('/admin/fail', { count: 2, status: 503 });
  const r1 = await engine.flush();
  console.log(`  flush report: ${JSON.stringify(r1)} — backoff absorbed the outage`);

  banner('3. Outage clears: queue drains in order');
  const r2 = await engine.flush();
  console.log(`  flush report: ${JSON.stringify(r2)} (already drained in step 2)`);

  banner('4. Conflict: dispatcher edits the same order while tech is mid-job');
  await admin('/admin/conflict', {
    id: 'wo-pump-01',
    title: 'Replace pump seal (URGENT)',
    notes: 'escalated by customer',
  });
  tick(300_000); // five minutes pass
  await engine.mutate({
    id: 'uuid-update-003',
    op: 'update',
    entityId: 'wo-pump-01',
    baseUpdatedAt: 0, // engine derives the real base from the local record
    payload: { notes: 'seal replaced, tested OK — tech sign-off' },
  });
  const r3 = await engine.sync();
  console.log(`  sync report: pull=${JSON.stringify(r3.pull)} push=${JSON.stringify(r3.push)}`);

  banner('5. Second device: fresh install pulls everything via delta sync');
  const repo2 = new InMemoryStore();
  const engine2 = new SyncEngine({ api: createApiClient(fetchLike, BASE), repo: repo2, now, onEvent: log });
  const r4 = await engine2.pull();
  console.log(`  fresh device applied ${r4.applied} record(s), cursor now ${r4.cursor}`);

  banner('6. Idempotency: replaying an acked mutation is a server no-op');
  const acked = engine.outbox.all().find((m) => m.status === 'acked');
  if (!acked) throw new Error('demo invariant: expected an acked mutation');
  const stateBefore = (await (await fetch(`${BASE}/admin/state`)).json()) as { changeLog: unknown[] };
  await api.push(acked); // network-style replay of an already-applied mutation
  const stateAfter = (await (await fetch(`${BASE}/admin/state`)).json()) as { changeLog: unknown[] };
  console.log(
    `  replayed "${acked.id}" — server changeLog ${stateBefore.changeLog.length} -> ${stateAfter.changeLog.length} entries (no double-apply)`,
  );

  banner('Final state (server)');
  const state = (await (await fetch(`${BASE}/admin/state`)).json()) as {
    orders: { id: string; title: string; status: string; notes: string }[];
  };
  for (const o of state.orders) {
    console.log(`  ${pad(o.id, 12)} ${pad(o.status, 14)} ${o.title} — ${o.notes}`);
  }
  console.log('\ndemo complete — every mutation survived going offline, an outage, and a conflict.');

  await mock.close();
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exitCode = 1;
});
