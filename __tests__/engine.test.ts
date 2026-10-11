import { SyncEngine, type SyncEvent } from '../src/sync/engine';
import { InMemoryStore } from '../src/db/in-memory';
import { RetryableApiError } from '../src/core/types';
import type { WorkOrderApi } from '../src/api/client';
import type { DeltaResponse, Mutation, PushResult, WorkOrder } from '../src/core/types';

/** Scripted fake API: each push/delta call consumes queued responses. */
function fakeApi(overrides: Partial<WorkOrderApi> = {}): WorkOrderApi & {
  pushes: Mutation[];
  queuePush: (r: PushResult | Error) => void;
  queueDelta: (d: DeltaResponse | Error) => void;
} {
  const pushQueue: (PushResult | Error)[] = [];
  const deltaQueue: (DeltaResponse | Error)[] = [];
  const pushes: Mutation[] = [];
  return {
    pushes,
    queuePush: (r) => void pushQueue.push(r),
    queueDelta: (d) => void deltaQueue.push(d),
    list: async () => [],
    get: async () => {
      throw new Error('unused');
    },
    async delta() {
      const next = deltaQueue.shift();
      if (!next) return { changes: [], deleted: [], nextCursor: 0 };
      if (next instanceof Error) throw next;
      return next;
    },
    async push(m) {
      pushes.push(m);
      const next = pushQueue.shift();
      if (!next) return { ok: true, record: { id: m.entityId, title: '', site: '', status: 'open', notes: '', updatedAt: 999 } };
      if (next instanceof Error) throw next;
      return next;
    },
    ...overrides,
  };
}

const wo = (id: string, updatedAt: number, over: Partial<WorkOrder> = {}): WorkOrder => ({
  id, title: 't', site: 's', status: 'open', notes: 'n', updatedAt, ...over,
});

function makeEngine(api: WorkOrderApi, opts: { now?: () => number } = {}) {
  const events: SyncEvent[] = [];
  const repo = new InMemoryStore();
  let clock = 1000;
  const engine = new SyncEngine({
    api,
    repo,
    now: opts.now ?? (() => ++clock * 1000),
    backoff: { baseMs: 1, capMs: 2, rng: () => 0 },
    maxAttemptsPerFlush: 3,
    onEvent: (e) => events.push(e),
  });
  return { engine, repo, events };
}

describe('SyncEngine.mutate', () => {
  it('writes through to the repo and enqueues one mutation', async () => {
    const { engine, repo } = makeEngine(fakeApi());
    await engine.mutate({ id: 'k1', op: 'create', entityId: 'wo-1', baseUpdatedAt: 0, payload: { title: 'New boiler job' } });
    expect(await repo.get('wo-1')).toMatchObject({ title: 'New boiler job' });
    expect(engine.outbox.pendingCount).toBe(1);
  });

  it('delete does not write through but queues the op', async () => {
    const { engine, repo } = makeEngine(fakeApi());
    await repo.upsert(wo('wo-1', 5));
    await engine.mutate({ id: 'k1', op: 'delete', entityId: 'wo-1', baseUpdatedAt: 5, payload: {} });
    expect(await repo.get('wo-1')).toBeDefined(); // removed only after server ack
    expect(engine.outbox.pending()[0].op).toBe('delete');
  });
});

describe('SyncEngine.flush', () => {
  it('pushes pending mutations in outbox order and acks them', async () => {
    const api = fakeApi();
    api.queuePush({ ok: true, record: wo('a', 10) });
    api.queuePush({ ok: true, record: wo('b', 11) });
    const { engine } = makeEngine(api);
    await engine.mutate({ id: 'k-a', op: 'create', entityId: 'a', baseUpdatedAt: 0, payload: { title: 'a' } });
    await engine.mutate({ id: 'k-b', op: 'create', entityId: 'b', baseUpdatedAt: 0, payload: { title: 'b' } });
    const report = await engine.flush();
    expect(report.pushed).toBe(2);
    expect(api.pushes.map((m) => m.entityId)).toEqual(['a', 'b']);
    expect(engine.outbox.pendingCount).toBe(0);
  });

  it('retries retryable errors with backoff and succeeds', async () => {
    const api = fakeApi();
    api.queuePush(new RetryableApiError('boom', 503));
    api.queuePush(new RetryableApiError('boom', 503));
    api.queuePush({ ok: true, record: wo('a', 10) });
    const { engine, events } = makeEngine(api);
    await engine.mutate({ id: 'k1', op: 'create', entityId: 'a', baseUpdatedAt: 0, payload: {} });
    const report = await engine.flush();
    expect(report).toMatchObject({ pushed: 1, retries: 2, failed: 0 });
    expect(events.filter((e) => e.kind === 'push_retry')).toHaveLength(2);
    expect(engine.outbox.get('k1')!.attempts).toBe(2);
  });

  it('gives up after maxAttempts and keeps the mutation queued', async () => {
    const api = fakeApi();
    for (let i = 0; i < 3; i++) api.queuePush(new RetryableApiError('down'));
    const { engine } = makeEngine(api);
    await engine.mutate({ id: 'k1', op: 'create', entityId: 'a', baseUpdatedAt: 0, payload: {} });
    const report = await engine.flush();
    expect(report).toMatchObject({ pushed: 0, failed: 1 });
    expect(engine.outbox.pendingCount).toBe(1);
  });

  it('conflict where local is newer: rebases base and retries until acked', async () => {
    const api = fakeApi();
    // server copy is OLDER than the local edit (local updatedAt from injected clock > 50)
    api.queuePush({ ok: false, conflict: true, current: wo('a', 50, { notes: 'server' }) });
    api.queuePush({ ok: true, record: wo('a', 60, { notes: 'local wins' }) });
    const { engine, events } = makeEngine(api);
    await engine.mutate({ id: 'k1', op: 'create', entityId: 'a', baseUpdatedAt: 0, payload: { notes: 'local wins' } });
    const report = await engine.flush();
    expect(report.conflicts).toBe(1);
    expect(report.pushed).toBe(1);
    expect(events.some((e) => e.kind === 'push_conflict_local_wins')).toBe(true);
    // retry must carry the rebased base so the server accepts it
    expect(api.pushes[1].baseUpdatedAt).toBe(50);
  });

  it('conflict where server is newer: local discarded, mutation acked', async () => {
    const api = fakeApi();
    api.queuePush({ ok: false, conflict: true, current: wo('a', 9_999_999, { notes: 'server wins' }) });
    const { engine, repo, events } = makeEngine(api);
    await engine.mutate({ id: 'k1', op: 'create', entityId: 'a', baseUpdatedAt: 0, payload: { notes: 'local' } });
    const report = await engine.flush();
    expect(report.conflicts).toBe(1);
    expect(report.pushed).toBe(0);
    expect((await repo.get('a'))!.notes).toBe('server wins');
    expect(engine.outbox.pendingCount).toBe(0);
    expect(events.some((e) => e.kind === 'push_conflict_server_wins')).toBe(true);
  });

  it('rebases later queued edits after an earlier ack moves the server clock', async () => {
    const api = fakeApi();
    api.queuePush({ ok: true, record: wo('a', 500) }); // create acked at server time 500
    api.queuePush({ ok: true, record: wo('a', 501) });
    const { engine } = makeEngine(api);
    await engine.mutate({ id: 'k1', op: 'create', entityId: 'a', baseUpdatedAt: 0, payload: { title: 'first' } });
    await engine.mutate({ id: 'k2', op: 'update', entityId: 'a', baseUpdatedAt: 0, payload: { title: 'second' } });
    await engine.flush();
    expect(api.pushes[1].baseUpdatedAt).toBe(500); // rebased, not stale 0
  });
});

describe('SyncEngine.pull (delta sync)', () => {
  it('applies changes and advances the cursor', async () => {
    const api = fakeApi();
    api.queueDelta({ changes: [wo('a', 10), wo('b', 11)], deleted: [], nextCursor: 77 });
    const { engine, repo } = makeEngine(api);
    const report = await engine.pull();
    expect(report.applied).toBe(2);
    expect(await repo.get('a')).toBeDefined();
    expect(await repo.getCursor()).toBe(77);
  });

  it('second pull only asks from the stored cursor (no re-download)', async () => {
    const api = fakeApi();
    const seen: number[] = [];
    api.delta = async (since) => {
      seen.push(since);
      return { changes: [], deleted: [], nextCursor: since + 1 };
    };
    const { engine } = makeEngine(api);
    await engine.pull();
    await engine.pull();
    expect(seen).toEqual([0, 1]);
  });

  it('keeps un-acked local edits when a newer server version arrives', async () => {
    const api = fakeApi();
    api.queueDelta({ changes: [wo('a', 9_999_999, { notes: 'server' })], deleted: [], nextCursor: 5 });
    const { engine, repo, events } = makeEngine(api);
    await engine.mutate({ id: 'k1', op: 'create', entityId: 'a', baseUpdatedAt: 0, payload: { notes: 'local pending' } });
    const report = await engine.pull();
    expect(report.conflictsKeptLocal).toBe(1);
    expect((await repo.get('a'))!.notes).toBe('local pending');
    expect(events.some((e) => e.kind === 'pull_conflict_kept_local')).toBe(true);
  });

  it('applies server deletions but not for entities with pending edits', async () => {
    const api = fakeApi();
    api.queueDelta({ changes: [], deleted: ['gone', 'pending-one'], nextCursor: 9 });
    const { engine, repo } = makeEngine(api);
    await repo.upsert(wo('gone', 1));
    await repo.upsert(wo('pending-one', 1));
    await engine.mutate({ id: 'k1', op: 'update', entityId: 'pending-one', baseUpdatedAt: 1, payload: { notes: 'mine' } });
    const report = await engine.pull();
    expect(report.deleted).toBe(1);
    expect(await repo.get('gone')).toBeUndefined();
    expect(await repo.get('pending-one')).toBeDefined();
  });

  it('cursor never moves backwards', async () => {
    const api = fakeApi();
    const { engine, repo } = makeEngine(api);
    await repo.setCursor(100);
    api.queueDelta({ changes: [], deleted: [], nextCursor: 50 });
    await engine.pull();
    expect(await repo.getCursor()).toBe(100);
  });
});

describe('SyncEngine.sync (pull then flush)', () => {
  it('runs pull before flush', async () => {
    const order: string[] = [];
    const api = fakeApi();
    api.delta = async () => {
      order.push('delta');
      return { changes: [], deleted: [], nextCursor: 1 };
    };
    api.push = async () => {
      order.push('push');
      return { ok: true, record: wo('a', 10) };
    };
    const { engine } = makeEngine(api);
    await engine.mutate({ id: 'k1', op: 'create', entityId: 'a', baseUpdatedAt: 0, payload: {} });
    await engine.sync();
    expect(order).toEqual(['delta', 'push']);
  });
});
