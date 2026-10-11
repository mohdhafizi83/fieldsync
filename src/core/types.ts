/**
 * Shared domain types. This module (and everything under src/sync) must stay
 * free of React Native imports so the sync engine is unit-testable in plain
 * Node/jest without a simulator.
 */

export type WorkOrderStatus = 'open' | 'in_progress' | 'done';

export interface WorkOrder {
  id: string;
  title: string;
  site: string;
  status: WorkOrderStatus;
  notes: string;
  /** Server (or local-edit) wall-clock timestamp, ms. Basis for LWW. */
  updatedAt: number;
}

export type MutationOp = 'create' | 'update' | 'delete';

export type MutationStatus = 'pending' | 'acked';

export interface Mutation {
  /** UUID idempotency key — survives app restarts, deduped server-side. */
  id: string;
  /** Monotonic local sequence; defines flush order. */
  seq: number;
  op: MutationOp;
  entityId: string;
  /** Server updatedAt observed when the edit was made (0 for creates). */
  baseUpdatedAt: number;
  payload: Partial<Omit<WorkOrder, 'id' | 'updatedAt'>>;
  createdAt: number;
  attempts: number;
  status: MutationStatus;
}

export interface DeltaResponse {
  changes: WorkOrder[];
  deleted: string[];
  nextCursor: number;
}

export type PushResult =
  | { ok: true; record: WorkOrder }
  | { ok: false; conflict: true; current: WorkOrder };

export class RetryableApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'RetryableApiError';
  }
}

/** Non-retryable HTTP failure (4xx other than 404/409 handling in the client). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}
