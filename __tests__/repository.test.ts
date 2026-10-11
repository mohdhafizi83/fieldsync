import { InMemoryStore } from '../src/db/in-memory';
import { SqliteWorkOrderRepository, type SqliteLike } from '../src/db/sqlite';
import type { WorkOrderRepository } from '../src/db/repository';
import type { WorkOrder } from '../src/core/types';

const order = (over: Partial<WorkOrder> = {}): WorkOrder => ({
  id: 'wo-1',
  title: 'Fix boiler',
  site: 'Plant B',
  status: 'open',
  notes: 'pressure drop',
  updatedAt: 100,
  ...over,
});

/** Shared contract suite run against every repository implementation. */
function repositoryContract(make: () => Promise<WorkOrderRepository>) {
  it('roundtrips a work order through upsert/get', async () => {
    const repo = await make();
    await repo.upsert(order());
    expect(await repo.get('wo-1')).toEqual(order());
  });

  it('upsert overwrites an existing record (same id)', async () => {
    const repo = await make();
    await repo.upsert(order());
    await repo.upsert(order({ title: 'Fix boiler v2', updatedAt: 200 }));
    const got = await repo.get('wo-1');
    expect(got?.title).toBe('Fix boiler v2');
    expect((await repo.all()).length).toBe(1);
  });

  it('get returns undefined for unknown ids; remove deletes', async () => {
    const repo = await make();
    expect(await repo.get('nope')).toBeUndefined();
    await repo.upsert(order());
    await repo.remove('wo-1');
    expect(await repo.get('wo-1')).toBeUndefined();
  });

  it('all() returns every record', async () => {
    const repo = await make();
    await repo.upsert(order({ id: 'a' }));
    await repo.upsert(order({ id: 'b' }));
    expect((await repo.all()).map((o) => o.id).sort()).toEqual(['a', 'b']);
  });

  it('cursor starts at 0 and persists setCursor', async () => {
    const repo = await make();
    expect(await repo.getCursor()).toBe(0);
    await repo.setCursor(42);
    expect(await repo.getCursor()).toBe(42);
  });

  it('returned records are copies (mutating them cannot corrupt the store)', async () => {
    const repo = await make();
    await repo.upsert(order());
    const got = (await repo.get('wo-1'))!;
    got.title = 'tampered';
    expect((await repo.get('wo-1'))!.title).toBe('Fix boiler');
  });
}

describe('InMemoryStore', () => {
  repositoryContract(async () => new InMemoryStore());
});

/**
 * Fake SQLite driver: keeps rows in Maps but executes the *statement shapes*
 * the adapter emits (we pattern-match the SQL), so CI proves the adapter's
 * SQL wiring without native modules.
 */
function fakeSqlite(): SqliteLike & { rows: Map<string, Record<string, unknown>>; meta: Map<string, number> } {
  const rows = new Map<string, Record<string, unknown>>();
  const meta = new Map<string, number>();
  return {
    rows,
    meta,
    execAsync: async () => {},
    async runAsync(source: string, ...params: (string | number | null)[]) {
      if (source.includes('INSERT INTO work_orders')) {
        rows.set(String(params[0]), {
          id: params[0], title: params[1], site: params[2], status: params[3], notes: params[4], updated_at: params[5],
        });
      } else if (source.includes('DELETE FROM work_orders')) {
        rows.delete(String(params[0]));
      } else if (source.includes('INSERT INTO sync_meta')) {
        meta.set(String(params[0]), Number(params[1]));
      }
      return {};
    },
    async getAllAsync<T>(source: string): Promise<T[]> {
      return [...rows.values()] as T[];
    },
    async getFirstAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T | null> {
      if (source.includes('FROM work_orders')) return (rows.get(String(params[0])) as T) ?? null;
      if (source.includes('FROM sync_meta')) {
        const v = meta.get(String(params[0]));
        return v === undefined ? null : ({ value: v } as T);
      }
      return null;
    },
  };
}

describe('SqliteWorkOrderRepository (fake driver — no native code in CI)', () => {
  repositoryContract(async () => SqliteWorkOrderRepository.initWith(fakeSqlite()));

  it('emits an UPSERT statement with all six columns bound', async () => {
    const db = fakeSqlite();
    const repo = await SqliteWorkOrderRepository.initWith(db);
    await repo.upsert(order());
    const row = db.rows.get('wo-1')!;
    expect(row).toEqual({
      id: 'wo-1', title: 'Fix boiler', site: 'Plant B', status: 'open', notes: 'pressure drop', updated_at: 100,
    });
  });
});
