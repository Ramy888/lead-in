// Prints a 24h Lead-In schedule for a classic-crime FAST channel. Runs on SYNTHETIC Qloo data until the
// hackathon key arrives; runtimes are TMDB values (Columbo/Murder, She Wrote/Baywatch verified live).

import { planDay, type LibraryItem } from "../pipeline.js";
import { FakeQlooClient } from "../qloo/fake.js";
import { TracingClient } from "../qloo/trace.js";
import { formatTime } from "../solver/dayparts.js";

const LIBRARY: LibraryItem[] = [
  { name: "Columbo", runtimeMinutes: 76 },
  { name: "Murder, She Wrote", runtimeMinutes: 45 },
  { name: "Matlock", runtimeMinutes: 48 },
  { name: "Perry Mason", runtimeMinutes: 51 },
  { name: "Diagnosis: Murder", runtimeMinutes: 45 },
  { name: "Quincy, M.E.", runtimeMinutes: 50 },
  { name: "The Rockford Files", runtimeMinutes: 50 },
  { name: "Magnum, P.I.", runtimeMinutes: 48 },
  { name: "Knight Rider", runtimeMinutes: 48 },
  { name: "The A-Team", runtimeMinutes: 48 },
  { name: "Walker, Texas Ranger", runtimeMinutes: 45 },
  { name: "Baywatch", runtimeMinutes: 42 },
  { name: "Law", runtimeMinutes: 45 }, // ambiguous on purpose: shows the needs_input path
];

const mode = process.argv.includes("--recommend") ? "recommend" : "compare";
const client = new TracingClient(new FakeQlooClient());
const started = performance.now();
const plan = await planDay(client, LIBRARY, { matrix: mode });
const ms = Math.round(performance.now() - started);

const name = new Map(plan.shows.map((s) => [s.id, s.name]));
console.log(`LEAD-IN — 24h grid (matrix: ${mode}; SYNTHETIC Qloo data, not real affinities) — solved in ${ms} ms\n`);
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
console.log(`\nQloo calls: ${client.trace.length} (${[...new Set(client.trace.map((t) => t.tool))].join(", ")})`);
console.log("TV data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.");
