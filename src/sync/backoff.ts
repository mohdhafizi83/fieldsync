export interface BackoffOptions {
  /** Delay base for attempt 0, ms. */
  baseMs: number;
  /** Hard ceiling on the exponential term, ms. */
  capMs: number;
  /** Injectable RNG in [0,1) — deterministic in tests. */
  rng?: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, capMs: 30_000 };

/**
 * Exponential backoff with "equal jitter": the exponential term is halved and
 * the other half is randomized, so the delay lands in [exp/2, exp). This keeps
 * a guaranteed floor (no thundering-herd zero delays) while still spreading
 * retries from many devices across the window.
 *
 *   attempt 0 -> [base/2, base)
 *   attempt 1 -> [base,   2*base)
 *   attempt n -> [min(cap, base*2^n)/2, min(cap, base*2^n))
 */
export function backoffDelay(attempt: number, opts: Partial<BackoffOptions> = {}): number {
  const { baseMs, capMs, rng = Math.random } = { ...DEFAULT_BACKOFF, ...opts };
  if (attempt < 0) throw new RangeError(`attempt must be >= 0, got ${attempt}`);
  const exp = Math.min(capMs, baseMs * Math.pow(2, attempt));
  const half = exp / 2;
  return Math.round(half + half * rng());
}
