import type { Mutation, MutationOp } from '../core/types';

export interface EnqueueInput {
  id: string; // caller-supplied UUID idempotency key
  op: MutationOp;
  entityId: string;
  baseUpdatedAt: number;
  payload: Mutation['payload'];
  createdAt?: number;
}

/**
 * Append-only mutation queue. Entries are never removed — acked mutations are
 * marked, so the log doubles as an audit trail and a crash-recovery record:
 * anything not `acked` is re-pushed after a restart, keyed by its UUID so the
 * server can dedupe replays.
 */
export class Outbox {
  private entries: Mutation[] = [];
  private seq = 0;

  /**
   * Append a mutation. If a mutation with the same idempotency key already
   * exists this is a no-op returning the existing entry (retry-safe enqueue).
   */
  enqueue(input: EnqueueInput, now: () => number = Date.now): Mutation {
    const existing = this.entries.find((m) => m.id === input.id);
    if (existing) return existing;
    const mutation: Mutation = {
      id: input.id,
      seq: this.seq++,
      op: input.op,
      entityId: input.entityId,
      baseUpdatedAt: input.baseUpdatedAt,
      payload: input.payload,
      createdAt: input.createdAt ?? now(),
      attempts: 0,
      status: 'pending',
    };
    this.entries.push(mutation);
    return mutation;
  }

  all(): readonly Mutation[] {
    return [...this.entries];
  }

  pending(): Mutation[] {
    return this.entries.filter((m) => m.status === 'pending').sort((a, b) => a.seq - b.seq);
  }

  get(id: string): Mutation | undefined {
    return this.entries.find((m) => m.id === id);
  }

  hasPendingFor(entityId: string): boolean {
    return this.entries.some((m) => m.status === 'pending' && m.entityId === entityId);
  }

  markAcked(id: string): void {
    const m = this.get(id);
    if (m) m.status = 'acked';
  }

  recordAttempt(id: string): void {
    const m = this.get(id);
    if (m) m.attempts += 1;
  }

  get pendingCount(): number {
    return this.entries.filter((m) => m.status === 'pending').length;
  }

  get size(): number {
    return this.entries.length;
  }
}
