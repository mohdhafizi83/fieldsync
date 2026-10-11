import { Outbox } from '../src/sync/outbox';

const input = (id: string, over: Partial<Parameters<Outbox['enqueue']>[0]> = {}) => ({
  id,
  op: 'update' as const,
  entityId: over.entityId ?? 'wo-1',
  baseUpdatedAt: 100,
  payload: { notes: 'x' },
  ...over,
});

describe('Outbox', () => {
  it('preserves insertion order via monotonic seq', () => {
    const outbox = new Outbox();
    const a = outbox.enqueue(input('a'));
    const b = outbox.enqueue(input('b'));
    const c = outbox.enqueue(input('c'));
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
    expect(outbox.pending().map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('dedupes by idempotency key — enqueueing the same UUID twice is a no-op', () => {
    const outbox = new Outbox();
    outbox.enqueue(input('dup'));
    const second = outbox.enqueue(input('dup', { payload: { notes: 'changed' } }));
    expect(outbox.size).toBe(1);
    expect(second.payload.notes).toBe('x'); // original payload kept
  });

  it('pending() excludes acked mutations; all() keeps them as an audit trail', () => {
    const outbox = new Outbox();
    outbox.enqueue(input('a'));
    outbox.enqueue(input('b'));
    outbox.markAcked('a');
    expect(outbox.pending().map((m) => m.id)).toEqual(['b']);
    expect(outbox.all()).toHaveLength(2);
    expect(outbox.get('a')!.status).toBe('acked');
    expect(outbox.pendingCount).toBe(1);
  });

  it('tracks attempts per mutation for retry accounting', () => {
    const outbox = new Outbox();
    outbox.enqueue(input('a'));
    outbox.recordAttempt('a');
    outbox.recordAttempt('a');
    expect(outbox.get('a')!.attempts).toBe(2);
  });

  it('hasPendingFor answers per-entity without leaking across entities', () => {
    const outbox = new Outbox();
    outbox.enqueue(input('a', { entityId: 'wo-1' }));
    outbox.enqueue(input('b', { entityId: 'wo-2' }));
    outbox.markAcked('a');
    expect(outbox.hasPendingFor('wo-1')).toBe(false);
    expect(outbox.hasPendingFor('wo-2')).toBe(true);
  });

  it('uses injected clock for createdAt (deterministic tests)', () => {
    const outbox = new Outbox();
    const m = outbox.enqueue(input('a'), () => 12345);
    expect(m.createdAt).toBe(12345);
  });
});
