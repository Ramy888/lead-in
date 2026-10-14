// End-to-end: show names + runtimes in, a 24h schedule with weak handoffs, weak dayparts and titles to
// license out. Used by the CLI demo now and the HTTP API later. The Qloo client decides data provenance.

import { fromAffinities, handoffScore, type OverlapMatrix } from "./matrix/overlap.js";
import type { Candidate, Demographics, Entity, QlooClient } from "./qloo/types.js";
import { DAYPARTS, DEFAULT_CLOCK, demographicFit, fitFunction, weakDayparts, type DaypartGap } from "./solver/dayparts.js";
import { annotate, scoreSequence, solve, type SolveResult, type SolverInput, type SolverShow } from "./solver/solve.js";

export interface LibraryItem {
  name: string;
  runtimeMinutes: number;
  /** Premiere year, to pick between same-named shows (Matlock 1986 vs 2024). */
  year?: number;
  /** Qloo ID chosen in the "which one?" picker; skips name matching. */
  qlooId?: string;
}

export interface PlanOptions {
  maxAirings?: number;
  /** Every licensed show airs at least this often. Default 1. */
  minAirings?: number;
  maxStack?: number;
  /** Ad time as a fraction of runtime; FAST channels run roughly 8–12 ad minutes an hour. Default 0.12. */
  adLoad?: number;
  /** Dayparts whose mean fit falls below this get licensing suggestions. Default 0.5. */
  gapThreshold?: number;
  /** Solver wall-clock budget. Default: none for libraries of up to 16 shows (they finish in about 2 s, and the
   *  same library then always gives the same day, however busy the server), 1500 ms for larger ones. */
  budgetMs?: number;
  /** Keep this airing order (show IDs) instead of solving: the day the user is looking at, manual moves included.
   *  Ignored unless it airs exactly the resolved shows, e.g. after the library changed. */
  order?: string[];
}

export interface LicenseSuggestion {
  daypart: string;
  title: Entity;
  /** Qloo affinity to the library as a whole. */
  affinity: number;
  /** Our 0..1 reading of that affinity, on the same scale as handoff scores. */
  match: number;
  /** Our daypart-fit estimate for the title. */
  fit: number;
}

export interface Plan {
  /** True when the Qloo data behind this plan is synthetic; the UI must say so. */
  synthetic: boolean;
  shows: Array<Entity & { units: number; runtimeMinutes: number }>;
  unresolved: Array<{ name: string; status: string; candidates?: Candidate[] }>;
  matrix: OverlapMatrix;
  /** Qloo audience skew per show (undefined where Qloo had none). */
  demographics: Map<string, Demographics | undefined>;
  /** What the solver ran on, kept so an edited day can be re-scored the same way. */
  solverInput: SolverInput;
  schedule: SolveResult;
  /** Shows left off the grid: only possible when the library has more airtime than a day. */
  notAired: string[];
  gaps: DaypartGap[];
  license: LicenseSuggestion[];
}

const LICENSE_CANDIDATES = 10;

export function unitsFor(runtimeMinutes: number, adLoad = 0.12): number {
  return Math.max(1, Math.ceil((runtimeMinutes * (1 + adLoad)) / 30));
}

export async function planDay(client: QlooClient, library: LibraryItem[], opts: PlanOptions = {}): Promise<Plan> {
  const shows: Plan["shows"] = [];
  const unresolved: Plan["unresolved"] = [];
  // Lookups run concurrently; the Qloo client spaces them to stay under the rate limit.
  const described = await Promise.all(
    library.map((item) => {
      const hint = { ...(item.qlooId ? { id: item.qlooId } : {}), ...(item.year ? { year: item.year } : {}) };
      return client.describe(item.name, "tv_show", hint);
    }),
  );
  for (const [i, item] of library.entries()) {
    const res = described[i]!;
    if (res.status === "ok" && res.data) {
      shows.push({ ...res.data, runtimeMinutes: item.runtimeMinutes, units: unitsFor(item.runtimeMinutes, opts.adLoad) });
    } else {
      unresolved.push({ name: item.name, status: res.status, ...(res.candidates ? { candidates: res.candidates } : {}) });
    }
  }

  if (!shows.length) {
    // Say why nothing could be scheduled, instead of letting the solver report an empty library.
    throw new Error(
      unresolved.some((u) => u.status === "error")
        ? "Qloo couldn't be reached, so no titles could be looked up. Try again in a minute."
        : "No title matched exactly one Qloo TV show. Use full titles, such as “Law & Order”.",
    );
  }

  const demographics = new Map<string, Demographics | undefined>();
  const demoResults = await Promise.all(shows.map((show) => client.audienceDemographics(show)));
  shows.forEach((show, i) => demographics.set(show.id, demoResults[i]!.status === "ok" ? demoResults[i]!.data : undefined));

  const matrix = await fromAffinities(client, shows);
  const solverShows: SolverShow[] = shows.map((s) => ({ id: s.id, units: s.units }));
  const dayUnits = (24 * 60) / DEFAULT_CLOCK.unitMinutes;
  // Small libraries must repeat more to fill the day; one airing of everything is the floor.
  const libraryUnits = solverShows.reduce((t, s) => t + s.units, 0);
  const neededAirings = libraryUnits ? Math.ceil(dayUnits / libraryUnits) + 1 : 0;
  // Airing everything at least once is only possible when the whole library fits in a day.
  const minAirings = libraryUnits <= dayUnits ? (opts.minAirings ?? 1) : 0;
  const solverInput: SolverInput = {
    shows: solverShows,
    dayUnits,
    handoff: (a, b) => matrix.score(a, b),
    fit: fitFunction(demographics),
    maxAirings: opts.maxAirings ?? Math.max(4, neededAirings),
    minAirings,
    maxStack: opts.maxStack ?? 2,
    stackScore: 0.6,
  };
  const ids = new Set(shows.map((s) => s.id));
  const keep = opts.order?.length && opts.order.every((id) => ids.has(id)) && ids.size === new Set(opts.order).size;
  const schedule: SolveResult = keep
    ? { slots: annotate(solverInput, opts.order!).slots, score: scoreSequence(solverInput, opts.order!) ?? -Infinity }
    : solve(solverInput, { budgetMs: opts.budgetMs ?? (shows.length <= 16 ? Infinity : 1500) });
  const aired = new Set(schedule.slots.map((s) => s.showId));
  const notAired = shows.filter((s) => !aired.has(s.id)).map((s) => s.id);
  const gaps = weakDayparts(schedule.slots, opts.gapThreshold ?? 0.5);

  const license = gaps.length && shows.length ? await suggestTitles(client, shows, gaps.map((g) => g.daypart)) : [];

  return { synthetic: client.synthetic ?? false, shows, unresolved, matrix, demographics, solverInput, schedule, notAired, gaps, license };
}

/** Titles outside the library that share its audience, ranked per daypart by fit × match (top 3 each).
 *  Used for the plan's licensing panel and by the agent. */
export async function suggestTitles(client: QlooClient, shows: Entity[], dayparts: string[]): Promise<LicenseSuggestion[]> {
  const libraryIds = new Set(shows.map((s) => s.id));
  const recs = await client.recommend(shows, "tv_show", 30);
  // Only the closest few get a demographics lookup: each one is a Qloo call against a monthly quota.
  const candidates = (recs.data ?? []).filter((r) => !libraryIds.has(r.entity.id)).slice(0, LICENSE_CANDIDATES);
  const candidateDemo = await Promise.all(candidates.map((c) => client.audienceDemographics(c.entity)));
  const out: LicenseSuggestion[] = [];
  for (const daypart of dayparts) {
    const profile = DAYPARTS.find((d) => d.name === daypart)?.profile;
    if (!profile) continue;
    const scored = candidates.map((c, i) => ({
      daypart,
      title: c.entity,
      affinity: c.affinity,
      match: handoffScore(c.affinity),
      fit: demographicFit(candidateDemo[i]!.data, profile),
    }));
    // Raw affinities differ only in the second decimal, so rank on the mapped match.
    scored.sort((a, b) => b.fit * b.match - a.fit * a.match);
    out.push(...scored.slice(0, 3));
  }
  return out;
}
