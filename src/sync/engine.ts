import type { WorkOrderApi } from '../api/client';
import type { WorkOrderRepository } from '../db/repository';
import { RetryableApiError } from '../core/types';
import type { Mutation, WorkOrder } from '../core/types';
import { Outbox, type EnqueueInput } from './outbox';
import { backoffDelay, type BackoffOptions } from './backoff';
import { applyPulledRecord, resolveConflict } from './conflict';

export interface SyncEvent {
  ts: number;
  kind:
    | 'enqueue'
    | 'push_ok'
    | 'push_retry'
    | 'push_conflict_local_wins'
    | 'push_conflict_server_wins'
    | 'pull_applied'
    | 'pull_conflict_kept_local'
    | 'pull_deleted'
    | 'cursor_advanced';
  message: string;
}

export interface SyncEngineOptions {
  api: WorkOrderApi;
  repo: WorkOrderRepository;
  outbox?: Outbox;
  backoff?: Partial<BackoffOptions>;
  maxAttemptsPerFlush?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: SyncEvent) => void;
}

export interface FlushReport {
  pushed: number;
  conflicts: number;
  retries: number;
  failed: number;
}

export interface PullReport {
  applied: number;
  deleted: number;
  conflictsKeptLocal: number;
  cursor: number;
}

const noSleep = async (_ms: number): Promise<void> => {};

/**
 * Orchestrates offline-first behaviour:
 *  - every local mutation goes through the outbox first (durable, idempotent)
 *  - flush pushes pending mutations in seq order with retry + backoff
 *  - pull applies server deltas with LWW, protecting un-acked local edits
 */
export class SyncEngine {
  readonly outbox: Outbox;
  private readonly api: WorkOrderApi;
  private readonly repo: WorkOrderRepository;
  private readonly backoff: Partial<BackoffOptions>;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly emit: (e: Omit<SyncEvent, 'ts'>) => void;

  constructor(opts: SyncEngineOptions) {
    this.api = opts.api;
    this.repo = opts.repo;
    this.outbox = opts.outbox ?? new Outbox();
    this.backoff = opts.backoff ?? {};
    this.maxAttempts = opts.maxAttemptsPerFlush ?? 5;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? noSleep;
    this.emit = (e) => opts.onEvent?.({ ts: this.now(), ...e });
  }

  /** Record a local edit: write-through to the repo + enqueue for the server. */
  async mutate(
    input: Omit<EnqueueInput, 'createdAt'> & { next?: Partial<WorkOrder> },
  ): Promise<WorkOrder | undefined> {
    const existing = input.op === 'create' ? undefined : await this.repo.get(input.entityId);
    const baseUpdatedAt = input.baseUpdatedAt ?? existing?.updatedAt ?? 0;
    const ts = this.now();

    if (input.op !== 'delete') {
      const base: WorkOrder = existing ?? {
        id: input.entityId,
        title: '',
        site: '',
        status: 'open',
        notes: '',
        updatedAt: 0,
      };
      await this.repo.upsert({
        ...base,
        ...input.payload,
        ...input.next,
        id: input.entityId,
        updatedAt: ts,
      });
    }

    this.outbox.enqueue({
      id: input.id,
      op: input.op,
      entityId: input.entityId,
      baseUpdatedAt,
      payload: input.payload,
      createdAt: ts,
    });
    this.emit({ kind: 'enqueue', message: `${input.op} ${input.entityId} queued (${this.outbox.pendingCount} pending)` });
    return input.op === 'delete' ? undefined : await this.repo.get(input.entityId);
  }

  /** Push all pending mutations in order. Retries with backoff; stops on hard errors. */
  async flush(): Promise<FlushReport> {
    const report: FlushReport = { pushed: 0, conflicts: 0, retries: 0, failed: 0 };
    for (const mutation of this.outbox.pending()) {
      await this.flushOne(mutation, report);
    }
    return report;
  }

  private async flushOne(mutation: Mutation, report: FlushReport): Promise<void> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        const result = await this.api.push(mutation);
        if (result.ok) {
          this.outbox.markAcked(mutation.id);
          await this.repo.upsert(result.record);
          this.rebasePending(mutation.entityId, mutation.seq, result.record.updatedAt);
          report.pushed++;
          this.emit({ kind: 'push_ok', message: `${mutation.op} ${mutation.entityId} acked (attempt ${attempt + 1})` });
          return;
        }
        // 409 conflict: LWW decides who keeps the record.
        report.conflicts++;
        const local = await this.repo.get(mutation.entityId);
        const localView: WorkOrder = local ?? {
          ...result.current,
          ...mutation.payload,
          id: mutation.entityId,
          updatedAt: mutation.createdAt,
        };
        const { winner, record } = resolveConflict(localView, result.current);
        if (winner === 'local') {
          // Rebase: adopt server clock so the retry is a strict LWW win.
          const rebased: WorkOrder = { ...localView, updatedAt: result.current.updatedAt + 1 };
          await this.repo.upsert(rebased);
          mutation.payload = {
            title: rebased.title,
            site: rebased.site,
            status: rebased.status,
            notes: rebased.notes,
          };
          mutation.baseUpdatedAt = result.current.updatedAt;
          this.rebasePending(mutation.entityId, mutation.seq, rebased.updatedAt);
          this.emit({
            kind: 'push_conflict_local_wins',
            message: `conflict on ${mutation.entityId}: local newer, rebased & retrying`,
          });
          continue; // same idempotency key, immediate retry
        }
        await this.repo.upsert(record);
        this.outbox.markAcked(mutation.id);
        this.rebasePending(mutation.entityId, mutation.seq, record.updatedAt);
        this.emit({
          kind: 'push_conflict_server_wins',
          message: `conflict on ${mutation.entityId}: server newer, local discarded`,
        });
        return;
      } catch (err) {
        if (!(err instanceof RetryableApiError)) throw err;
        this.outbox.recordAttempt(mutation.id);
        report.retries++;
        if (attempt === this.maxAttempts - 1) {
          report.failed++;
          this.emit({
            kind: 'push_retry',
            message: `${mutation.op} ${mutation.entityId} still failing after ${this.maxAttempts} attempts — stays queued`,
          });
          return;
        }
        const delay = backoffDelay(attempt, this.backoff);
        this.emit({
          kind: 'push_retry',
          message: `${mutation.op} ${mutation.entityId} failed (${err.message}); retry in ${delay}ms`,
        });
        await this.sleep(delay);
      }
    }
  }

  /**
   * After a mutation for an entity is acked (ok or conflict-resolved), the
   * server clock for that entity moved. Later queued edits to the same entity
   * were based on the pre-ack state — rebase them so they don't spuriously
   * conflict on their next push.
   */
  private rebasePending(entityId: string, afterSeq: number, newBase: number): void {
    for (const m of this.outbox.pending()) {
      if (m.entityId === entityId && m.seq > afterSeq) m.baseUpdatedAt = newBase;
    }
  }

  /** Pull deltas since the stored cursor and merge with LWW. */
  async pull(): Promise<PullReport> {
    const since = await this.repo.getCursor();
    const delta = await this.api.delta(since);
    const report: PullReport = { applied: 0, deleted: 0, conflictsKeptLocal: 0, cursor: since };

    for (const incoming of delta.changes) {
      const local = await this.repo.get(incoming.id);
      const pending = this.outbox.hasPendingFor(incoming.id);
      const merged = applyPulledRecord(local, incoming, pending);
      if (merged === local && local) {
        report.conflictsKeptLocal++;
        this.emit({
          kind: 'pull_conflict_kept_local',
          message: `kept local ${incoming.id} (un-acked edit wins until acked)`,
        });
      } else {
        await this.repo.upsert(merged!);
        report.applied++;
        this.emit({ kind: 'pull_applied', message: `applied server change for ${incoming.id}` });
      }
    }

    for (const id of delta.deleted) {
      if (!this.outbox.hasPendingFor(id)) {
        await this.repo.remove(id);
        report.deleted++;
        this.emit({ kind: 'pull_deleted', message: `removed ${id} (deleted server-side)` });
      }
    }

    if (delta.nextCursor > since) {
      await this.repo.setCursor(delta.nextCursor);
      report.cursor = delta.nextCursor;
      this.emit({ kind: 'cursor_advanced', message: `delta cursor ${since} -> ${delta.nextCursor}` });
    }
    return report;
  }

  /** pull then flush — the normal "back online" cycle. */
  async sync(): Promise<{ pull: PullReport; push: FlushReport }> {
    const pull = await this.pull();
    const push = await this.flush();
    return { pull, push };
  }
}
