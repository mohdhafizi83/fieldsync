import type { WorkOrder } from '../core/types';

/**
 * Storage seam for the sync engine. The engine only ever talks to this
 * interface, so unit tests use InMemoryStore and the app uses the SQLite
 * adapter — CI never needs native code.
 */
export interface WorkOrderRepository {
  get(id: string): Promise<WorkOrder | undefined>;
  all(): Promise<WorkOrder[]>;
  upsert(order: WorkOrder): Promise<void>;
  remove(id: string): Promise<void>;
  /** Opaque cursor for delta sync; 0 = never synced. */
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
  close(): Promise<void>;
}
