import { backoffDelay, DEFAULT_BACKOFF } from '../src/sync/backoff';

describe('backoffDelay (exponential + equal jitter)', () => {
  const opts = { baseMs: 500, capMs: 30_000 };

  it('attempt 0 with rng=0 lands at half the base (guaranteed floor)', () => {
    expect(backoffDelay(0, { ...opts, rng: () => 0 })).toBe(250);
  });

  it('attempt n with rng=0 is exactly base * 2^n / 2 (until the cap)', () => {
    expect(backoffDelay(1, { ...opts, rng: () => 0 })).toBe(500);
    expect(backoffDelay(2, { ...opts, rng: () => 0 })).toBe(1000);
    expect(backoffDelay(3, { ...opts, rng: () => 0 })).toBe(2000);
    expect(backoffDelay(5, { ...opts, rng: () => 0 })).toBe(8000); // 500*32/2
    expect(backoffDelay(10, { ...opts, rng: () => 0 })).toBe(15_000); // capped: 30000/2
  });

  it('rng near 1 approaches (but rounding keeps it at) the full exponential term', () => {
    // rng is documented as [0,1); with 0.999 the delay stays strictly under exp
    expect(backoffDelay(2, { ...opts, rng: () => 0.999 })).toBeLessThan(2000);
    expect(backoffDelay(2, { ...opts, rng: () => 0.999 })).toBeGreaterThanOrEqual(1000);
  });

  it('caps the exponential term at capMs', () => {
    expect(backoffDelay(100, { ...opts, rng: () => 0 })).toBe(15_000); // cap/2
    expect(backoffDelay(100, { ...opts, rng: () => 0.5 })).toBe(22_500); // cap*0.75
  });

  it('jitter window is always [exp/2, exp) for every attempt', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const exp = Math.min(opts.capMs, opts.baseMs * 2 ** attempt);
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const d = backoffDelay(attempt, { ...opts, rng: () => r });
        expect(d).toBeGreaterThanOrEqual(Math.round(exp / 2));
        expect(d).toBeLessThanOrEqual(exp);
      }
    }
  });

  it('rejects negative attempts', () => {
    expect(() => backoffDelay(-1)).toThrow(RangeError);
  });

  it('defaults are sane (500ms base, 30s cap)', () => {
    expect(DEFAULT_BACKOFF).toEqual({ baseMs: 500, capMs: 30_000 });
  });
});
