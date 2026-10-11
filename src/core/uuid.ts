/**
 * Idempotency keys must be unique per mutation and survive restarts (they are
 * persisted with the outbox entry). RFC-4122 v4 shape, generated from a
 * CSPRNG only:
 *
 *   1. globalThis.crypto.getRandomValues — Hermes/RN with expo-crypto polyfill,
 *      browsers, Node >= 19.
 *   2. process.getBuiltinModule('node:crypto').randomBytes — pure-Node tooling
 *      (demo, tests) without touching package.json deps.
 *
 * There is deliberately NO Math.random fallback: a predictable idempotency key
 * defeats server-side dedup (two colliding mutations apply twice), so we fail
 * loudly instead of silently weakening the key.
 */
function csprngBytes(length: number): Uint8Array {
  const g = globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    const out = new Uint8Array(length);
    g.crypto.getRandomValues(out);
    return out;
  }
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (typeof proc?.getBuiltinModule === 'function') {
    try {
      const nodeCrypto = proc.getBuiltinModule('node:crypto') as
        | { randomBytes?: (n: number) => Uint8Array }
        | undefined;
      if (nodeCrypto?.randomBytes) return new Uint8Array(nodeCrypto.randomBytes(length));
    } catch {
      /* fall through to the loud failure below */
    }
  }
  throw new Error(
    'no CSPRNG available (globalThis.crypto.getRandomValues / node:crypto missing) — ' +
      'refusing to generate a weak idempotency key',
  );
}

export function uuidv4(): string {
  const bytes = csprngBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
