// Lead-In vs days built without Qloo, on every preset: the same Claude model scheduling from its own knowledge
// (several attempts), the library in listed order, and 50 shuffled orders. All scored on the same Qloo-derived scale.
// Writes bench/results.json and prints a table. npm run bench  (some cents on the Anthropic API; Qloo answers cached)

import { mkdirSync, writeFileSync } from "node:fs";
import { ClaudeModel } from "../agent/claude.js";
import { compareDays, type DayMetrics } from "../bench/compare.js";
import { planDay } from "../pipeline.js";
import { snapshotOf } from "../plan-snapshot.js";
import { PRESETS } from "../presets.js";
import { qlooFromEnv } from "../qloo/from-env.js";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw new Error("ANTHROPIC_API_KEY missing (../.env)");
const attempts = Number(process.env.ATTEMPTS ?? 3);
// Same model and effort as the agent, so the only difference is Qloo.
const model = new ClaudeModel({ apiKey: key });
const qloo = qlooFromEnv();
const avg = (ms: DayMetrics[], k: keyof DayMetrics) => Math.round((ms.reduce((t, m) => t + m[k], 0) / ms.length) * 1000) / 1000;
const results = [];
let usd = 0;

for (const preset of PRESETS) {
  const snap = snapshotOf(await planDay(qloo, preset.library));
  const base = await compareDays(snap, null, { samples: 50 });
  const attemptsOut = [];
  const errors: string[] = [];
  for (let i = 0; i < attempts; i++) {
    const r = await compareDays(snap, model, { samples: 1 });
    if (r.aiOnly) attemptsOut.push(r.aiOnly);
    if (r.aiOnlyError) errors.push(r.aiOnlyError);
  }
  usd += attemptsOut.reduce((t, a) => t + a.usd, 0);
  results.push({
    preset: preset.name,
    shows: snap.shows.length,
    leadIn: base.leadIn,
    aiOnly: attemptsOut.length
      ? { flow: avg(attemptsOut, "flow"), weakHandoffs: avg(attemptsOut, "weakHandoffs"), fit: avg(attemptsOut, "fit"), violations: avg(attemptsOut, "violations") }
      : null,
    aiOnlyAttempts: attemptsOut.map((a) => ({ flow: a.flow, weakHandoffs: a.weakHandoffs, violations: a.violations, repaired: a.repaired, unknownTitles: a.unknownTitles, model: a.model, usd: a.usd })),
    listed: base.listed,
    shuffled: base.shuffled,
    errors,
  });
}
qloo.flush();
mkdirSync("bench", { recursive: true });
writeFileSync("bench/results.json", JSON.stringify({ date: new Date().toISOString().slice(0, 10), model: "claude-opus-5-5", attempts, results }, null, 2) + "\n");

const row = (name: string, m: DayMetrics | null) =>
  m ? `  ${name.padEnd(24)} flow ${m.flow.toFixed(3)}  weak ${String(m.weakHandoffs).padStart(5)}  fit ${m.fit.toFixed(3)}  rule breaks ${m.violations}` : `  ${name.padEnd(24)} (no answer)`;
for (const r of results) {
  console.log(`\n${r.preset} (${r.shows} shows)`);
  console.log(row("Lead-In (Qloo)", r.leadIn));
  console.log(row(`Claude alone ×${r.aiOnlyAttempts.length}`, r.aiOnly));
  for (const a of r.aiOnlyAttempts) console.log(`      flow ${a.flow} weak ${a.weakHandoffs} breaks ${a.violations} repaired=${a.repaired}${a.unknownTitles.length ? " unknown=" + JSON.stringify(a.unknownTitles) : ""} $${a.usd.toFixed(4)}`);
  for (const e of r.errors) console.log("      error:", e);
  console.log(row("Listed order", r.listed));
  console.log(row("Shuffled ×50", r.shuffled));
}
console.log(`\nClaude spend: $${usd.toFixed(4)}`);
