import * as SQLite from 'expo-sqlite';

import type { WorkOrder } from '../core/types';
import type { WorkOrderRepository } from './repository';

type SqlParam = string | number | null;

/**
 * Structural subset of expo-sqlite's `SQLiteDatabase` that this adapter needs.
 * Tests inject a fake implementing just these methods, so CI exercises the
 * adapter's SQL logic without native modules.
 */
export interface SqliteLike {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: SqlParam[]): Promise<unknown>;
  getAllAsync<T>(source: string, ...params: SqlParam[]): Promise<T[]>;
  getFirstAsync<T>(source: string, ...params: SqlParam[]): Promise<T | null>;
}

interface Row {
  id: string;
  title: string;
  site: string;
  status: WorkOrder['status'];
  notes: string;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  site TEXT NOT NULL,
  status TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

function rowToOrder(row: Row): WorkOrder {
  return {
    id: row.id,
    title: row.title,
    site: row.site,
    status: row.status,
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

export class SqliteWorkOrderRepository implements WorkOrderRepository {
  private constructor(private readonly db: SqliteLike) {}

  static async open(name = 'fieldsync.db'): Promise<SqliteWorkOrderRepository> {
    const db = await SQLite.openDatabaseAsync(name);
    const repo = new SqliteWorkOrderRepository(db as unknown as SqliteLike);
    await repo.init();
    return repo;
  }

  /** Exposed so tests can pass a fake driver. */
  static async initWith(db: SqliteLike): Promise<SqliteWorkOrderRepository> {
    const repo = new SqliteWorkOrderRepository(db);
    await repo.init();
    return repo;
  }

  private async init(): Promise<void> {
    await this.db.execAsync(SCHEMA);
  }

  async get(id: string): Promise<WorkOrder | undefined> {
    const row = await this.db.getFirstAsync<Row>(
      'SELECT id, title, site, status, notes, updated_at FROM work_orders WHERE id = ?',
      id,
    );
    return row ? rowToOrder(row) : undefined;
  }

  async all(): Promise<WorkOrder[]> {
    const rows = await this.db.getAllAsync<Row>(
      'SELECT id, title, site, status, notes, updated_at FROM work_orders ORDER BY updated_at DESC',
    );
    return rows.map(rowToOrder);
  }

  async upsert(order: WorkOrder): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO work_orders (id, title, site, status, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, site = excluded.site, status = excluded.status,
         notes = excluded.notes, updated_at = excluded.updated_at`,
      order.id,
      order.title,
      order.site,
      order.status,
      order.notes,
      order.updatedAt,
    );
  }

  async remove(id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM work_orders WHERE id = ?', id);
  }

  async getCursor(): Promise<number> {
    const row = await this.db.getFirstAsync<{ value: number }>(
      'SELECT value FROM sync_meta WHERE key = ?',
      'delta_cursor',
    );
    return row?.value ?? 0;
  }

  async setCursor(cursor: number): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      'delta_cursor',
      cursor,
    );
  }

  async close(): Promise<void> {
    const maybeClose = (this.db as unknown as { closeAsync?: () => Promise<void> }).closeAsync;
    if (maybeClose) await maybeClose.call(this.db);
  }
}
