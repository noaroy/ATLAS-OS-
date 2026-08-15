/**
 * Sliding-window rate limiting.
 *
 * Written rather than pulled in: ATLAS needs one behaviour — "how many times
 * has this key acted in the last N ms" — and a small, testable implementation
 * is easier to reason about in the auth path than a general-purpose plugin.
 *
 * Sliding rather than fixed-window because a fixed window lets an attacker
 * make 2× the allowance across a boundary, which is exactly the burst a login
 * limiter is supposed to stop.
 */

export interface RateLimitOptions {
  /** Maximum actions allowed inside the window. */
  limit: number;
  windowMs: number;
  /** How many keys to track before evicting the coldest. Bounds memory. */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the caller may retry. 0 when allowed. */
  retryAfterMs: number;
}

export class RateLimiter {
  #hits = new Map<string, number[]>();
  #limit: number;
  #windowMs: number;
  #maxKeys: number;

  constructor(options: RateLimitOptions) {
    this.#limit = Math.max(1, options.limit);
    this.#windowMs = Math.max(1, options.windowMs);
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  /** Records an attempt and reports whether it is permitted. */
  consume(key: string, now = Date.now()): RateLimitResult {
    const cutoff = now - this.#windowMs;
    const timestamps = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= this.#limit) {
      this.#hits.set(key, timestamps);
      // The window frees up when the oldest recorded attempt falls out of it.
      const retryAfterMs = Math.max(0, timestamps[0]! + this.#windowMs - now);
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    timestamps.push(now);
    this.#hits.set(key, timestamps);
    this.#evictIfNeeded(now);

    return { allowed: true, remaining: this.#limit - timestamps.length, retryAfterMs: 0 };
  }

  /** Clears a key — used after a successful login so one bad typo is forgiven. */
  reset(key: string): void {
    this.#hits.delete(key);
  }

  /** Reports without recording, for callers that only want to check. */
  peek(key: string, now = Date.now()): RateLimitResult {
    const cutoff = now - this.#windowMs;
    const timestamps = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (timestamps.length >= this.#limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, timestamps[0]! + this.#windowMs - now),
      };
    }
    return { allowed: true, remaining: this.#limit - timestamps.length, retryAfterMs: 0 };
  }

  get trackedKeys(): number {
    return this.#hits.size;
  }

  /**
   * Drops expired entries, and the coldest keys if the map is still oversized.
   *
   * Without this an attacker rotating source addresses would grow the map
   * without bound — the limiter itself becomes the denial of service.
   */
  #evictIfNeeded(now: number): void {
    if (this.#hits.size <= this.#maxKeys) return;

    const cutoff = now - this.#windowMs;
    for (const [key, timestamps] of this.#hits) {
      const live = timestamps.filter((t) => t > cutoff);
      if (live.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, live);
    }

    if (this.#hits.size <= this.#maxKeys) return;

    // Still oversized: evict by oldest last-activity until back within bounds.
    const byAge = [...this.#hits.entries()].sort(
      (a, b) => (a[1].at(-1) ?? 0) - (b[1].at(-1) ?? 0),
    );
    for (const [key] of byAge.slice(0, this.#hits.size - this.#maxKeys)) {
      this.#hits.delete(key);
    }
  }
}
