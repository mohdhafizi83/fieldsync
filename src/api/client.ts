import { ApiError, RetryableApiError } from '../core/types';
import type { DeltaResponse, Mutation, PushResult, WorkOrder } from '../core/types';

/** Minimal fetch-like seam — tests inject a stub, no network in CI. */
export interface FetchLike {
  (url: string, init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<{
    status: number;
    json(): Promise<unknown>;
  }>;
}

export interface WorkOrderApi {
  list(): Promise<WorkOrder[]>;
  get(id: string): Promise<WorkOrder>;
  delta(since: number): Promise<DeltaResponse>;
  push(mutation: Mutation): Promise<PushResult>;
}

export function createApiClient(fetchImpl: FetchLike, baseUrl: string): WorkOrderApi {
  const base = baseUrl.replace(/\/+$/, '');

  async function request<T>(path: string, init?: Parameters<FetchLike>[1]): Promise<T> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
    } catch (err) {
      // Network-level failure (offline, DNS, reset) — always retryable.
      throw new RetryableApiError(err instanceof Error ? err.message : 'network error');
    }
    if (res.status >= 500 || res.status === 429) {
      throw new RetryableApiError(`server error ${res.status}`, res.status);
    }
    if (res.status === 409) {
      const body = (await res.json()) as { current: WorkOrder };
      return { ok: false, conflict: true, current: body.current } as unknown as T;
    }
    if (res.status === 404) {
      throw new RetryableApiError('not found', 404);
    }
    if (res.status >= 400) {
      // Every non-2xx leaves this function as a typed error — never a silent
      // parse of an error body.
      throw new ApiError(`unexpected status ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }

  return {
    list: () => request<WorkOrder[]>('/work-orders'),
    get: (id) => request<WorkOrder>(`/work-orders/${encodeURIComponent(id)}`),
    delta: (since) => request<DeltaResponse>(`/delta?since=${since}`),
    push: (m) =>
      request<PushResult>(`/work-orders/${encodeURIComponent(m.entityId)}/push`, {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: m.id,
          op: m.op,
          baseUpdatedAt: m.baseUpdatedAt,
          payload: m.payload,
        }),
      }),
  };
}
