// End-to-end: show names + runtimes in, a 24h schedule with weak handoffs, weak dayparts and titles to
// license out. Used by the CLI demo now and the HTTP API later. The Qloo client decides data provenance.

import { fromCompare, fromRecommend, type OverlapMatrix } from "./matrix/overlap.js";
import type { Candidate, Demographics, Entity, QlooClient } from "./qloo/types.js";
import { DAYPARTS, DEFAULT_CLOCK, demographicFit, fitFunction, weakDayparts, type DaypartGap } from "./solver/dayparts.js";
import { solve, type SolveResult, type SolverShow } from "./solver/solve.js";

export interface LibraryItem {
  name: string;
  runtimeMinutes: number;
}

export interface PlanOptions {
  matrix: "compare" | "recommend";
  maxAirings?: number;
  /** Every licensed show airs at least this often. Default 1. */
  minAirings?: number;
  maxStack?: number;
  /** Ad time as a fraction of runtime; FAST channels run roughly 8–12 ad minutes an hour. Default 0.12. */
  adLoad?: number;
  /** Dayparts whose mean fit falls below this get licensing suggestions. Default 0.5. */
  gapThreshold?: number;
}

export interface LicenseSuggestion {
  daypart: string;
  title: Entity;
  /** Qloo affinity to the library as a whole. */
  affinity: number;
  /** Our daypart-fit estimate for the title. */
  fit: number;
}

export interface Plan {
  shows: Array<Entity & { units: number; runtimeMinutes: number }>;
  unresolved: Array<{ name: string; status: string; candidates?: Candidate[] }>;
  matrix: OverlapMatrix;
  schedule: SolveResult;
  gaps: DaypartGap[];
  license: LicenseSuggestion[];
}

export function unitsFor(runtimeMinutes: number, adLoad = 0.12): number {
  return Math.max(1, Math.ceil((runtimeMinutes * (1 + adLoad)) / 30));
}

export async function planDay(client: QlooClient, library: LibraryItem[], opts: PlanOptions): Promise<Plan> {
  const shows: Plan["shows"] = [];
  const unresolved: Plan["unresolved"] = [];
  for (const item of library) {
    const res = await client.describe(item.name, "tv_show");
    if (res.status === "ok" && res.data) {
      shows.push({ ...res.data, runtimeMinutes: item.runtimeMinutes, units: unitsFor(item.runtimeMinutes, opts.adLoad) });
    } else {
      unresolved.push({ name: item.name, status: res.status, ...(res.candidates ? { candidates: res.candidates } : {}) });
    }
  }

  const demographics = new Map<string, Demographics | undefined>();
  for (const show of shows) {
    const res = await client.audienceDemographics(show);
    demographics.set(show.id, res.status === "ok" ? res.data : undefined);
  }

  const matrix = opts.matrix === "compare" ? await fromCompare(client, shows) : await fromRecommend(client, shows);
  const solverShows: SolverShow[] = shows.map((s) => ({ id: s.id, units: s.units }));
  const dayUnits = (24 * 60) / DEFAULT_CLOCK.unitMinutes;
  // Small libraries must repeat more to fill the day; one airing of everything is the floor.
  const libraryUnits = solverShows.reduce((t, s) => t + s.units, 0);
  const neededAirings = libraryUnits ? Math.ceil(dayUnits / libraryUnits) + 1 : 0;
  const schedule = solve({
    shows: solverShows,
    dayUnits,
    handoff: (a, b) => matrix.score(a, b),
    fit: fitFunction(demographics),
    maxAirings: opts.maxAirings ?? Math.max(4, neededAirings),
    minAirings: opts.minAirings ?? 1,
    maxStack: opts.maxStack ?? 2,
    stackScore: 0.6,
  });
  const gaps = weakDayparts(schedule.slots, opts.gapThreshold ?? 0.5);

  const license: LicenseSuggestion[] = [];
  if (gaps.length && shows.length) {
    const libraryIds = new Set(shows.map((s) => s.id));
    const recs = await client.recommend(shows, "tv_show", 30);
    const candidates = (recs.data ?? []).filter((r) => !libraryIds.has(r.entity.id));
    for (const gap of gaps) {
      const profile = DAYPARTS.find((d) => d.name === gap.daypart)!.profile;
      const scored = [];
      for (const c of candidates) {
        const demo = await client.audienceDemographics(c.entity);
        scored.push({ daypart: gap.daypart, title: c.entity, affinity: c.affinity, fit: demographicFit(demo.data, profile) });
      }
      scored.sort((a, b) => b.fit * b.affinity - a.fit * a.affinity);
      license.push(...scored.slice(0, 3));
    }
  }

  return { shows, unresolved, matrix, schedule, gaps, license };
}
