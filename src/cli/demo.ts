// Prints a 24h Lead-In schedule for the classic-crime preset plus one ambiguous title. Uses real Qloo when
// QLOO_API_KEY is set (npm run demo loads ../.env), the synthetic stand-in otherwise.

import { planDay, type LibraryItem } from "../pipeline.js";
import { qlooFromEnv } from "../qloo/from-env.js";
import { PRESETS } from "../presets.js";
import { TracingClient } from "../qloo/trace.js";
import { formatTime } from "../solver/dayparts.js";

const LIBRARY: LibraryItem[] = [
  ...PRESETS[0]!.library,
  { name: "Law", runtimeMinutes: 45 }, // ambiguous on purpose: shows the needs_input path
];

const qloo = qlooFromEnv();
const client = new TracingClient(qloo);
const started = performance.now();
const plan = await planDay(client, LIBRARY, {});
const ms = Math.round(performance.now() - started);

const name = new Map(plan.shows.map((s) => [s.id, s.name]));
const source = plan.synthetic ? "SYNTHETIC stand-in data, not real Qloo affinities" : "Qloo data";
console.log(`LEAD-IN — 24h grid (${source}) — solved in ${ms} ms\n`);
plan.schedule.slots.forEach((slot, i) => {
  const next = plan.schedule.slots[(i + 1) % plan.schedule.slots.length]!;
  const arrow = slot.showId === next.showId ? "  (stacked)" : `  → ${slot.handoffScore.toFixed(2)}${slot.weakHandoff ? "  WEAK HANDOFF" : ""}`;
  console.log(`${formatTime(slot.startUnit)}  ${name.get(slot.showId)!.padEnd(22)} fit ${slot.fit.toFixed(2)}${arrow}`);
});

console.log("\nWeak dayparts:", plan.gaps.length ? plan.gaps.map((g) => `${g.daypart} (${g.meanFit})`).join(", ") : "none");
for (const s of plan.license) console.log(`  license for ${s.daypart}: ${s.title.name} (affinity ${s.affinity}, fit ${s.fit.toFixed(2)})`);
for (const u of plan.unresolved) {
  console.log(`\nNeeds input: "${u.name}" (${u.status}) → ${(u.candidates ?? []).map((c) => c.name).join(" | ")}`);
}
qloo.flush();
console.log(`\nQloo calls: ${client.trace.length}, ${client.trace.filter((t) => t.cached).length} from cache (${[...new Set(client.trace.map((t) => t.tool))].join(", ")})`);
console.log("TV data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.");
