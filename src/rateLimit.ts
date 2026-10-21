// In-memory fixed-window limiter. Fine for a single replica; swap for Redis
// when you scale out (the interface stays the same).
export interface Limit {
  max: number;
  windowMs: number;
}

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: Limit) {}

  /** Records a hit for `key`. Returns seconds to wait if over the limit, otherwise 0. */
  hit(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.limit.windowMs });
      this.sweep(now);
      return 0;
    }
    if (entry.count >= this.limit.max) return Math.ceil((entry.resetAt - now) / 1000);
    entry.count++;
    return 0;
  }

  get size(): number {
    return this.hits.size;
  }

  // Drop expired windows so memory stays bounded by active clients.
  private sweep(now: number): void {
    if (this.hits.size < 10_000) return;
    for (const [key, e] of this.hits) if (e.resetAt <= now) this.hits.delete(key);
  }
}
