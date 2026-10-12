// Bounded in-memory cache in front of Qloo, so reloading a preset doesn't spend quota again.
// Only successful answers are cached; failures are retried on the next request.

import type { CompareResult, Demographics, Entity, Envelope, QlooClient, Recommendation } from "./types.js";

interface Entry {
  value: Envelope<unknown>;
  expires: number;
}

export class CachingClient implements QlooClient {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly inner: QlooClient,
    private readonly maxEntries = 2000,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  get synthetic(): boolean {
    return this.inner.synthetic ?? false;
  }

  get size(): number {
    return this.entries.size;
  }

  private async cached<T>(key: string, call: () => Promise<Envelope<T>>): Promise<Envelope<T>> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) {
      // Re-insert so the Map's insertion order doubles as least-recently-used order.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return { ...(hit.value as Envelope<T>), cached: true };
    }
    const value = await call();
    if (value.status === "ok" || value.status === "empty") {
      this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    }
    return value;
  }

  describe(name: string, type: Entity["type"]): Promise<Envelope<Entity>> {
    return this.cached(`describe|${type}|${name.trim().toLowerCase()}`, () => this.inner.describe(name, type));
  }

  recommend(signals: Entity[], targetType: Entity["type"], limit: number): Promise<Envelope<Recommendation[]>> {
    const key = `recommend|${targetType}|${limit}|${signals.map((s) => s.id).sort().join(",")}`;
    return this.cached(key, () => this.inner.recommend(signals, targetType, limit));
  }

  audienceDemographics(entity: Entity): Promise<Envelope<Demographics>> {
    return this.cached(`demographics|${entity.id}`, () => this.inner.audienceDemographics(entity));
  }

  compareAudiences(a: Entity[], b: Entity[]): Promise<Envelope<CompareResult>> {
    // Overlap is symmetric, so A|B and B|A share one entry.
    const [x, y] = [a.map((e) => e.id).sort().join(","), b.map((e) => e.id).sort().join(",")].sort();
    return this.cached(`compare|${x}|${y}`, () => this.inner.compareAudiences(a, b));
  }
}
