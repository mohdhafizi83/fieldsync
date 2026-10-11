/**
 * Mock work-order server — Node stdlib only, zero dependencies.
 *
 * Implements the REST contract the app's API client speaks, plus two knobs
 * that make the sync engine's retry/conflict paths observable in a demo:
 *
 *   artificial latency : LATENCY_MS env or /admin/latency {ms}
 *   failure injection  : /admin/fail {count, status} -> next N pushes fail
 *   conflict injection : /admin/conflict {id, title, updatedAt} -> server-side
 *                        edit that is newer than anything the client holds
 *   idempotency        : pushes replaying a seen idempotencyKey return the
 *                        original result instead of applying twice
 *
 * DEV-ONLY: never deploy this. No auth, no TLS, in-memory state.
 *
 * Run: node mock-server/server.js [port]
 */
'use strict';

const http = require('http');

/** Hard cap on request bodies (1 MiB) — this is a demo, nobody posts megabytes. */
const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createMockServer({ port = 4000, latencyMs = 0, clock = Date.now } = {}) {
  /** @type {Map<string, object>} */
  const orders = new Map();
  /** Monotonic server clock — delta cursor = this. */
  let serverClock = clock();
  /** @type {{seq: number, order?: object, id: string}[]} */
  const changeLog = [];
  /** idempotencyKey -> last result, so replays are no-ops. */
  const seenKeys = new Map();
  let failBudget = { count: 0, status: 503 };
  let latency = latencyMs;

  function logChange(order) {
    changeLog.push({ seq: serverClock, order });
  }

  function applyPayload(order, payload) {
    return {
      ...order,
      title: payload.title ?? order.title,
      site: payload.site ?? order.site,
      status: payload.status ?? order.status,
      notes: payload.notes ?? order.notes,
    };
  }

  function handle(req, res) {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    const send = (status, body) => {
      if (res.headersSent || res.writableEnded) return;
      const json = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(json);
    };
    const readBody = () =>
      new Promise((resolve, reject) => {
        let raw = '';
        let bytes = 0;
        let overflow = false;
        req.on('data', (c) => {
          if (overflow) return; // stop accumulating; Node drains the rest after the reply
          bytes += c.length;
          if (bytes > MAX_BODY_BYTES) {
            overflow = true;
            reject(new HttpError(413, 'request body exceeds 1 MiB'));
            return;
          }
          raw += c;
        });
        req.on('end', () => {
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            resolve({});
          }
        });
        req.on('error', () => reject(new HttpError(400, 'request body unreadable')));
      });

    setTimeout(async () => {
      try {
        await route(req, url, path, send, readBody);
      } catch (err) {
        // Never leak stack traces or internals: fixed, generic messages only.
        const status = err instanceof HttpError ? err.status : 500;
        send(status, { error: status === 413 ? 'request body too large' : 'internal error' });
      }
    }, latency);
  }

  function route(req, url, path, send, readBody) {
    return (async () => {
      // ---- admin knobs -------------------------------------------------
      if (path === '/admin/latency' && req.method === 'POST') {
        const b = await readBody();
        latency = Number(b.ms ?? 0);
        return send(200, { latency });
      }
      if (path === '/admin/fail' && req.method === 'POST') {
        const b = await readBody();
        failBudget = { count: Number(b.count ?? 0), status: Number(b.status ?? 503) };
        return send(200, failBudget);
      }
      if (path === '/admin/conflict' && req.method === 'POST') {
        const b = await readBody();
        const existing = orders.get(b.id);
        if (!existing) return send(404, { error: 'no such work order' });
        serverClock = Math.max(serverClock, clock()) + 1;
        const updated = {
          ...existing,
          title: b.title ?? existing.title,
          notes: b.notes ?? existing.notes,
          status: b.status ?? existing.status,
          updatedAt: serverClock,
        };
        orders.set(b.id, updated);
        logChange(updated);
        return send(200, updated);
      }
      if (path === '/admin/state' && req.method === 'GET') {
        return send(200, {
          orders: [...orders.values()],
          changeLog,
          serverClock,
          seenKeys: [...seenKeys.keys()],
        });
      }

      // ---- injected failure window -------------------------------------
      if (failBudget.count > 0 && req.method === 'POST' && path.endsWith('/push')) {
        failBudget.count -= 1;
        return send(failBudget.status, { error: 'injected failure' });
      }

      // ---- work-order API ----------------------------------------------
      if (path === '/work-orders' && req.method === 'GET') {
        return send(200, [...orders.values()]);
      }
      const getOne = path.match(/^\/work-orders\/([^/]+)$/);
      if (getOne && req.method === 'GET') {
        const o = orders.get(decodeURIComponent(getOne[1]));
        return o ? send(200, o) : send(404, { error: 'not found' });
      }
      if (path === '/delta' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? 0);
        const changesById = new Map();
        const deleted = new Set();
        for (const entry of changeLog) {
          if (entry.seq > since) {
            if (entry.order) {
              changesById.set(entry.order.id, entry.order); // latest wins
              deleted.delete(entry.order.id);
            } else {
              deleted.add(entry.id);
              changesById.delete(entry.id);
            }
          }
        }
        return send(200, {
          changes: [...changesById.values()],
          deleted: [...deleted],
          nextCursor: serverClock,
        });
      }
      const pushMatch = path.match(/^\/work-orders\/([^/]+)\/push$/);
      if (pushMatch && req.method === 'POST') {
        const id = decodeURIComponent(pushMatch[1]);
        const body = await readBody();
        const key = body.idempotencyKey;
        if (!key) return send(400, { error: 'idempotencyKey required' });
        if (seenKeys.has(key)) return send(200, seenKeys.get(key)); // replay-safe

        if (body.op === 'delete') {
          const existed = orders.get(id);
          if (existed) {
            orders.delete(id);
            changeLog.push({ seq: ++serverClock, id });
          }
          const result = { ok: true, record: existed ?? null };
          seenKeys.set(key, result);
          return send(200, result);
        }

        const existing = orders.get(id);
        // Optimistic concurrency: client's base must match current server state.
        if (existing && Number(body.baseUpdatedAt) !== existing.updatedAt) {
          return send(409, { conflict: true, current: existing });
        }
        serverClock = Math.max(serverClock, clock()) + 1;
        const base = existing ?? {
          id,
          title: '',
          site: '',
          status: 'open',
          notes: '',
          updatedAt: 0,
        };
        const record = { ...applyPayload(base, body.payload ?? {}), id, updatedAt: serverClock };
        orders.set(id, record);
        logChange(record);
        const result = { ok: true, record };
        seenKeys.set(key, result);
        return send(200, result);
      }

      send(404, { error: 'no route' });
    })();
  }

  const server = http.createServer(handle);
  // Bound request lifetime so a stalled client can never hold a socket open.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  // Malformed requests: answer 400 quietly instead of dumping a stack trace.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return {
    server,
    // Loopback only: this is a dev/demo server and must never face a network.
    listen: () =>
      new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address()))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createMockServer };

if (require.main === module) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4000);
  const { listen } = createMockServer({ port, latencyMs: Number(process.env.LATENCY_MS ?? 0) });
  listen().then((addr) =>
    console.log(`fieldsync mock server listening on http://127.0.0.1:${addr.port}`),
  );
}
