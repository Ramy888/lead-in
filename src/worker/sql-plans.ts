// Plans waiting to be re-scored, kept in the Coordinator's SQLite so a drag still works after the Durable
// Object is evicted between "plan" and "drag". Rows expire after 6 hours; at most 500 are kept.

import type { PlanSnapshot } from "../plan-snapshot.js";
import type { PlanStore } from "../server/handler.js";

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ROWS = 500;

export class SqlPlanStore implements PlanStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, expires INTEGER NOT NULL)");
  }

  get(id: string): PlanSnapshot | undefined {
    const row = this.sql.exec<{ snapshot: string }>("SELECT snapshot FROM plans WHERE id = ? AND expires > ?", id, Date.now()).toArray()[0];
    return row ? (JSON.parse(row.snapshot) as PlanSnapshot) : undefined;
  }

  set(id: string, plan: PlanSnapshot): void {
    const now = Date.now();
    this.sql.exec("INSERT OR REPLACE INTO plans (id, snapshot, expires) VALUES (?, ?, ?)", id, JSON.stringify(plan), now + TTL_MS);
    this.sql.exec("DELETE FROM plans WHERE expires <= ?", now);
    this.sql.exec("DELETE FROM plans WHERE id NOT IN (SELECT id FROM plans ORDER BY expires DESC LIMIT ?)", MAX_ROWS);
  }
}
