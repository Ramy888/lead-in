// Node cache store: one JSON file, rewritten at most once a second (atomic rename). Used by the local
// server and the CLI; the Cloudflare deploy uses the Durable Object's SQLite instead.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CacheEntry, CacheStore } from "./cache.js";

export class FileCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly path: string) {}

  load(): Array<[string, CacheEntry]> {
    try {
      for (const [k, v] of JSON.parse(readFileSync(this.path, "utf8")) as Array<[string, CacheEntry]>) this.entries.set(k, v);
    } catch {
      // No cache yet, or unreadable: start empty.
    }
    return [...this.entries];
  }

  set(key: string, entry: CacheEntry): void {
    this.entries.set(key, entry);
    this.schedule();
  }

  delete(key: string): void {
    if (this.entries.delete(key)) this.schedule();
  }

  /** A crash loses at most the last second's answers. */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 1000);
    this.timer.unref();
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.entries]));
      renameSync(tmp, this.path);
    } catch (err) {
      console.error("Qloo cache not saved:", err instanceof Error ? err.message : err);
    }
  }
}
