import { uuidv4 } from '../src/core/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv4', () => {
  it('produces RFC-4122 v4 shaped keys', () => {
    for (let i = 0; i < 50; i++) expect(uuidv4()).toMatch(V4);
  });

  it('never repeats (collision-free over a sample)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const u = uuidv4();
      expect(seen.has(u)).toBe(false);
      seen.add(u);
    }
  });

  it('draws from crypto.getRandomValues, not Math.random', () => {
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let calls = 0;
    (globalThis.crypto as any).getRandomValues = (b: Uint8Array) => {
      calls++;
      return real(b as Uint8Array<ArrayBuffer>);
    };
    const randomSpy = jest.spyOn(Math, 'random');
    try {
      uuidv4();
      expect(calls).toBe(1);
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis.crypto as any).getRandomValues = real;
      randomSpy.mockRestore();
    }
  });

  it('falls back to node:crypto when globalThis.crypto is absent', () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(uuidv4()).toMatch(V4);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });
});
