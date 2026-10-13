// Qloo cache persisted in the Coordinator's SQLite, one row per entry (KV values cap at 128 KiB, and the
// whole cache is far bigger). SQLite calls are synchronous, so this fits the CacheStore contract directly.

import type { CacheEntry, CacheStore } from "../qloo/cache.js";

export class SqlCacheStore implements CacheStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS qloo_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");
  }

  load(): Array<[string, CacheEntry]> {
    // Oldest first, so the in-memory LRU order roughly survives a restart.
    return this.sql
      .exec<{ key: string; value: string; expires: number }>("SELECT key, value, expires FROM qloo_cache ORDER BY expires")
      .toArray()
      .map((r) => [r.key, { value: JSON.parse(r.value), expires: r.expires }]);
  }

  set(key: string, entry: CacheEntry): void {
    this.sql.exec("INSERT OR REPLACE INTO qloo_cache (key, value, expires) VALUES (?, ?, ?)", key, JSON.stringify(entry.value), entry.expires);
  }

  delete(key: string): void {
    this.sql.exec("DELETE FROM qloo_cache WHERE key = ?", key);
  }
}
