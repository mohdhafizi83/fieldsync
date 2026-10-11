/**
 * Hardening tests for the dev-only mock server: loopback bind, body cap,
 * generic error bodies (no stack traces).
 *
 * Uses node:http directly — the jest-expo environment stubs global fetch.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMockServer } from '../mock-server/server';

function req(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: raw });
          }
        });
      },
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

describe('mock server hardening', () => {
  let mock: ReturnType<typeof createMockServer>;
  let port: number;

  beforeAll(async () => {
    mock = createMockServer({ port: 0 });
    const addr = await mock.listen();
    port = addr.port;
  });

  afterAll(async () => {
    await mock.close();
  });

  it('binds to loopback only', () => {
    expect((mock.server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('rejects bodies over 1 MiB with 413 and a generic message', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const res = await req(port, 'POST', '/work-orders/wo-1/push', JSON.stringify({ idempotencyKey: 'big', op: 'update', payload: { notes: huge } }));
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: 'request body too large' });
    expect(JSON.stringify(res.json)).not.toMatch(/\n\s+at |Error:|\bat \w+.*\(.*:\d+:\d+\)/);
  });

  it('accepts bodies under the cap', async () => {
    const res = await req(port, 'POST', '/work-orders/wo-small/push', JSON.stringify({ idempotencyKey: 'small', op: 'update', payload: { notes: 'ok' } }));
    expect(res.status).toBe(200);
  });

  it('unknown routes get a JSON 404, not a stack trace', async () => {
    const res = await req(port, 'GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'no route' });
  });

  it('configures request timeouts', () => {
    expect(mock.server.requestTimeout).toBeGreaterThan(0);
    expect(mock.server.headersTimeout).toBeGreaterThan(0);
  });
});
