import { createApiClient, type FetchLike } from '../src/api/client';
import { RetryableApiError } from '../src/core/types';
import type { Mutation } from '../src/core/types';

function stubFetch(handler: (url: string, init?: Parameters<FetchLike>[1]) => { status: number; body: unknown } | 'throw'): {
  fetch: FetchLike;
  calls: { url: string; init?: Parameters<FetchLike>[1] }[];
} {
  const calls: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const res = handler(url, init);
    if (res === 'throw') throw new Error('ECONNREFUSED');
    return { status: res.status, json: async () => res.body };
  };
  return { fetch, calls };
}

const mutation: Mutation = {
  id: 'key-1', seq: 0, op: 'update', entityId: 'wo-1', baseUpdatedAt: 5,
  payload: { notes: 'x' }, createdAt: 1, attempts: 0, status: 'pending',
};

describe('createApiClient', () => {
  it('GETs list and get with the base url', async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: [] }));
    const api = createApiClient(fetch, 'http://x.test');
    await api.list();
    await api.get('wo/1');
    expect(calls[0].url).toBe('http://x.test/work-orders');
    expect(calls[1].url).toBe('http://x.test/work-orders/wo%2F1');
  });

  it('delta passes the since cursor as a query param', async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { changes: [], deleted: [], nextCursor: 0 } }));
    const api = createApiClient(fetch, 'http://x.test');
    await api.delta(123);
    expect(calls[0].url).toBe('http://x.test/delta?since=123');
  });

  it('push sends the idempotency key and payload', async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { ok: true, record: {} } }));
    const api = createApiClient(fetch, 'http://x.test');
    await api.push(mutation);
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(calls[0].init!.body!)).toEqual({
      idempotencyKey: 'key-1', op: 'update', baseUpdatedAt: 5, payload: { notes: 'x' },
    });
  });

  it('maps network errors to RetryableApiError', async () => {
    const { fetch } = stubFetch(() => 'throw');
    const api = createApiClient(fetch, 'http://x.test');
    await expect(api.list()).rejects.toThrow(RetryableApiError);
  });

  it('maps 5xx and 429 to RetryableApiError', async () => {
    for (const status of [500, 503, 429]) {
      const { fetch } = stubFetch(() => ({ status, body: {} }));
      const api = createApiClient(fetch, 'http://x.test');
      await expect(api.list()).rejects.toThrow(RetryableApiError);
    }
  });

  it('maps 409 to a conflict result carrying the current record', async () => {
    const current = { id: 'wo-1', title: 'srv', site: 's', status: 'open', notes: 'srv', updatedAt: 9 };
    const { fetch } = stubFetch(() => ({ status: 409, body: { current } }));
    const api = createApiClient(fetch, 'http://x.test');
    const result = await api.push(mutation);
    expect(result).toEqual({ ok: false, conflict: true, current });
  });

  it('strips trailing slashes from the base url', async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: [] }));
    const api = createApiClient(fetch, 'http://x.test///');
    await api.list();
    expect(calls[0].url).toBe('http://x.test/work-orders');
  });
});
