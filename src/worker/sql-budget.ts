// The agent's spend guard in the Coordinator's SQLite, so an evicted Durable Object can't reset it:
// runs per UTC day, and Nemotron spend (USD, from list prices) since the deploy.

import { dayOf, type AgentBudget } from "../server/limits.js";

export class SqlAgentBudget implements AgentBudget {
  constructor(
    private readonly sql: SqlStorage,
    private readonly maxRunsPerDay: number,
    private readonly maxUsd: number,
  ) {
    sql.exec("CREATE TABLE IF NOT EXISTS agent_runs (day TEXT PRIMARY KEY, runs INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS agent_spend (id INTEGER PRIMARY KEY CHECK (id = 1), usd REAL NOT NULL)");
    sql.exec("INSERT OR IGNORE INTO agent_spend (id, usd) VALUES (1, 0)");
  }

  blocked(now = Date.now()): string | null {
    const usd = this.sql.exec<{ usd: number }>("SELECT usd FROM agent_spend WHERE id = 1").one().usd;
    if (usd >= this.maxUsd) return "The agent's model budget for this demo is used up; planning still works.";
    const runs = this.sql.exec<{ runs: number }>("SELECT runs FROM agent_runs WHERE day = ?", dayOf(now)).toArray()[0]?.runs ?? 0;
    if (runs >= this.maxRunsPerDay) return "The agent has hit today's run limit; try again tomorrow. Planning still works.";
    return null;
  }

  startRun(now = Date.now()): void {
    this.sql.exec("INSERT INTO agent_runs (day, runs) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET runs = runs + 1", dayOf(now));
  }

  spend(usd: number): void {
    this.sql.exec("UPDATE agent_spend SET usd = usd + ? WHERE id = 1", usd);
  }
}
