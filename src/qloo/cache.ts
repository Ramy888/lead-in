// Bounded in-memory cache in front of Qloo, so reloading a preset doesn't spend quota again.
// Only successful answers are cached; failures are retried on the next request. With a file path the
// cache survives restarts and redeploys, which matters on a 10,000-calls-a-month key.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Demographics, DescribeHint, Entity, Envelope, QlooClient, Recommendation } from "./types.js";

interface Entry {
  value: Envelope<unknown>;
  expires: number;
}

export class CachingClient implements QlooClient {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly inner: QlooClient,
    private readonly maxEntries = 2000,
    private readonly ttlMs = 7 * 24 * 60 * 60 * 1000,
    private readonly persistPath?: string,
  ) {
    if (persistPath) this.load(persistPath);
  }

  private saveTimer: NodeJS.Timeout | undefined;

  private load(path: string): void {
    let saved: Array<[string, Entry]>;
    try {
      saved = JSON.parse(readFileSync(path, "utf8")) as Array<[string, Entry]>;
    } catch {
      return; // No cache yet, or unreadable: start empty.
    }
    const now = Date.now();
    for (const [key, entry] of saved.slice(-this.maxEntries)) if (entry.expires > now) this.entries.set(key, entry);
  }

  /** Writes at most once a second; a crash loses at most that second's answers. */
  private scheduleSave(): void {
    if (!this.persistPath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 1000);
    this.saveTimer.unref();
  }

  flush(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.entries]));
      renameSync(tmp, this.persistPath);
    } catch (err) {
      console.error("Qloo cache not saved:", err instanceof Error ? err.message : err);
    }
  }

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
    if (value.status === "ok" || value.status === "empty") this.store(key, value);
    return value;
  }

  private store(key: string, value: Envelope<unknown>): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.scheduleSave();
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
    if (fresh.status !== "ok" && fresh.status !== "empty") return known.length ? { ...fresh, data: [...known, ...(fresh.data ?? [])] } : fresh;
    const byId = new Map((fresh.data ?? []).map((r) => [r.entity.id, r]));
    for (const t of missing) {
      // A target Qloo didn't score is cached as an empty answer, so it isn't asked again either.
      const r = byId.get(t.id);
      this.store(pairKey(t), r ? { status: "ok", data: [r] } : { status: "empty", data: [] });
    }
    const data = [...known, ...(fresh.data ?? [])];
    return { status: data.length ? "ok" : "empty", data };
  }
}
