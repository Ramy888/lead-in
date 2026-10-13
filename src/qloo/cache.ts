// Bounded in-memory cache in front of Qloo, so reloading a preset doesn't spend quota again.
// Only successful answers are cached; failures are retried on the next request. With a store the cache
// survives restarts and redeploys, which matters on a 10,000-calls-a-month key. Runtime-neutral: the file
// store (Node) and the SQLite store (Cloudflare Durable Object) live in their own modules.

import type { Demographics, DescribeHint, Entity, Envelope, QlooClient, Recommendation } from "./types.js";

export interface CacheEntry {
  value: Envelope<unknown>;
  expires: number;
}

/** Where cache entries persist. Calls are synchronous; a store may batch writes itself. */
export interface CacheStore {
  load(): Array<[string, CacheEntry]>;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  flush?(): void;
}

export class CachingClient implements QlooClient {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly inner: QlooClient,
    private readonly maxEntries = 2000,
    private readonly ttlMs = 7 * 24 * 60 * 60 * 1000,
    private readonly store?: CacheStore,
    /** How long an expired answer is kept as a fallback for when Qloo fails. The demo must outlive the
     *  hackathon key (Nebius judging runs to Dec 15; Qloo only promises the key through Nov 17). */
    private readonly keepStaleMs = 120 * 24 * 60 * 60 * 1000,
  ) {
    if (!store) return;
    const now = Date.now();
    for (const [key, entry] of store.load()) {
      if (this.usable(entry, now) && this.entries.size < this.maxEntries) this.entries.set(key, entry);
      else store.delete(key);
    }
  }

  private usable(entry: CacheEntry, now: number): boolean {
    return entry.expires + this.keepStaleMs > now;
  }

  get synthetic(): boolean {
    return this.inner.synthetic ?? false;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Writes out anything the store is still batching (call on shutdown). */
  flush(): void {
    this.store?.flush?.();
  }

  private async cached<T>(key: string, call: () => Promise<Envelope<T>>): Promise<Envelope<T>> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) {
      // Re-insert so the Map's insertion order doubles as least-recently-used order.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return { ...(hit.value as Envelope<T>), cached: true };
    }
    const value = await call();
    if (value.status === "ok" || value.status === "empty") this.put(key, value);
    // Qloo failed (down, key revoked, quota reserve): an old answer beats no answer.
    else if (value.status === "error" && hit && this.usable(hit, now)) return { ...(hit.value as Envelope<T>), cached: true, stale: true };
    return value;
  }

  private put(key: string, value: Envelope<unknown>): void {
    const entry = { value, expires: Date.now() + this.ttlMs };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.store?.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
      this.store?.delete(oldest);
    }
  }

  describe(name: string, type: Entity["type"], hint?: DescribeHint): Promise<Envelope<Entity>> {
    const key = `describe|${type}|${name.trim().toLowerCase()}|${hint?.id ?? ""}|${hint?.year ?? ""}`;
    return this.cached(key, () => this.inner.describe(name, type, hint));
  }

  recommend(signals: Entity[], targetType: Entity["type"], limit: number): Promise<Envelope<Recommendation[]>> {
    const key = `recommend|${targetType}|${limit}|${signals.map((s) => s.id).sort().join(",")}`;
    return this.cached(key, () => this.inner.recommend(signals, targetType, limit));
  }

  audienceDemographics(entity: Entity): Promise<Envelope<Demographics>> {
    return this.cached(`demographics|${entity.id}`, () => this.inner.audienceDemographics(entity));
  }

  /** Cached per pair, so adding one show to a library asks Qloo only about the new pairs. */
  async affinities(from: Entity, targets: Entity[]): Promise<Envelope<Recommendation[]>> {
    const now = Date.now();
    const pairKey = (t: Entity) => `affinity|${from.id}|${t.id}`;
    const known: Recommendation[] = [];
    const missing: Entity[] = [];
    for (const t of targets) {
      const hit = this.entries.get(pairKey(t));
      if (hit && hit.expires > now) known.push(...((hit.value.data as Recommendation[] | undefined) ?? []));
      else missing.push(t);
    }
    if (!missing.length) return { status: known.length ? "ok" : "empty", data: known, cached: true };

    const fresh = await this.inner.affinities(from, missing);
    if (fresh.status !== "ok" && fresh.status !== "empty") {
      // Fall back to expired pairs where we have them; pairs we never had stay missing (reported as gaps).
      const old = missing.flatMap((t) => {
        const hit = this.entries.get(pairKey(t));
        return hit && this.usable(hit, now) ? [hit.value.data as Recommendation[]] : [];
      });
      const stale = old.length > 0;
      const data = [...known, ...old.flat(), ...(fresh.data ?? [])];
      if (!data.length && !stale) return fresh;
      const complete = old.length === missing.length;
      return { ...fresh, status: complete ? (data.length ? "ok" : "empty") : "partial", data, cached: true, ...(stale ? { stale: true } : {}) };
    }
    const byId = new Map((fresh.data ?? []).map((r) => [r.entity.id, r]));
    for (const t of missing) {
      // A target Qloo didn't score is cached as an empty answer, so it isn't asked again either.
      const r = byId.get(t.id);
      this.put(pairKey(t), r ? { status: "ok", data: [r] } : { status: "empty", data: [] });
    }
    const data = [...known, ...(fresh.data ?? [])];
    return { status: data.length ? "ok" : "empty", data };
  }
}
