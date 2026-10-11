import type { WorkOrder } from '../core/types';
import type { WorkOrderRepository } from './repository';

/** Map-backed repository used by tests and the zero-credential demo. */
export class InMemoryStore implements WorkOrderRepository {
  private orders = new Map<string, WorkOrder>();
  private cursor = 0;

  async get(id: string): Promise<WorkOrder | undefined> {
    const found = this.orders.get(id);
    return found ? { ...found } : undefined;
  }

  async all(): Promise<WorkOrder[]> {
    return [...this.orders.values()].map((o) => ({ ...o }));
  }

  async upsert(order: WorkOrder): Promise<void> {
    this.orders.set(order.id, { ...order });
  }

  async remove(id: string): Promise<void> {
    this.orders.delete(id);
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  async setCursor(cursor: number): Promise<void> {
    this.cursor = cursor;
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
