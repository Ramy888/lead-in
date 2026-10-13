// Per-client token buckets for the public, unauthenticated API. In memory: one container, one process.

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    private readonly maxClients = 10_000,
  ) {}

  /** Takes one token for `key`; false means the client is over its limit. */
  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 60_000) * this.refillPerMinute);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.delete(key);
    this.buckets.set(key, b);
    while (this.buckets.size > this.maxClients) this.buckets.delete(this.buckets.keys().next().value!);
    return ok;
  }
}

/** Time-limited, size-capped store for plans so an edited day can be re-scored. */
export class TtlStore<T> {
  private readonly items = new Map<string, { value: T; expires: number }>();

  constructor(private readonly maxItems: number, private readonly ttlMs: number) {}

  set(key: string, value: T): void {
    this.items.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.items.size > this.maxItems) this.items.delete(this.items.keys().next().value!);
  }

  get(key: string): T | undefined {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    return hit.value;
  }
}

/** Global spend guard for the agent: a daily run cap and a total Nemotron budget (USD). */
export interface AgentBudget {
  /** Why a new run can't start, or null if it can. */
  blocked(now?: number): string | null;
  startRun(now?: number): void;
  spend(usd: number): void;
}

export const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/** In-memory budget (Node). The Cloudflare deploy persists the same numbers in SQLite. */
export class MemoryAgentBudget implements AgentBudget {
  private day = "";
  private runs = 0;
  private usd = 0;

  constructor(private readonly maxRunsPerDay = 40, private readonly maxUsd = 10) {}

  blocked(now = Date.now()): string | null {
    if (this.usd >= this.maxUsd) return "The agent's model budget for this demo is used up; planning still works.";
    if (dayOf(now) === this.day && this.runs >= this.maxRunsPerDay) return "The agent has hit today's run limit; try again tomorrow. Planning still works.";
    return null;
  }

  startRun(now = Date.now()): void {
    if (dayOf(now) !== this.day) [this.day, this.runs] = [dayOf(now), 0];
    this.runs++;
  }

  spend(usd: number): void {
    this.usd += usd;
  }
}
