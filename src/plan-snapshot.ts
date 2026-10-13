// What re-scoring an edited day needs from a plan, as plain JSON. A Plan holds the solver's handoff and
// fit as functions, which can't be stored; the snapshot keeps the data behind them and rebuilds them, so a
// plan survives in SQLite when the Cloudflare Durable Object is evicted between "plan" and "drag".

import type { Plan } from "./pipeline.js";
import type { Demographics } from "./qloo/types.js";
import { fitFunction } from "./solver/dayparts.js";
import type { SolverInput } from "./solver/solve.js";

export interface PlanSnapshot {
  shows: Array<{ id: string; name: string }>;
  /** Show IDs of the planned airings, in order. */
  slots: string[];
  rules: Omit<SolverInput, "handoff" | "fit">;
  /** Directional handoff scores the solver used: [from, to, score]. */
  edges: Array<[string, string, number]>;
  demographics: Array<[string, Demographics | null]>;
}

export function snapshotOf(plan: Plan): PlanSnapshot {
  const { handoff, fit, ...rules } = plan.solverInput;
  const ids = plan.shows.map((s) => s.id);
  const edges: PlanSnapshot["edges"] = [];
  for (const a of ids) for (const b of ids) if (a !== b) edges.push([a, b, handoff(a, b)]);
  return {
    shows: plan.shows.map((s) => ({ id: s.id, name: s.name })),
    slots: plan.schedule.slots.map((s) => s.showId),
    rules,
    edges,
    demographics: ids.map((id) => [id, plan.demographics.get(id) ?? null]),
  };
}

/** Rebuilds the solver input the plan was made with. */
export function solverInputOf(snap: PlanSnapshot): SolverInput {
  const edges = new Map(snap.edges.map(([a, b, s]) => [`${a}\u0000${b}`, s]));
  const demographics = new Map(snap.demographics.map(([id, d]) => [id, d ?? undefined]));
  return { ...snap.rules, handoff: (a, b) => edges.get(`${a}\u0000${b}`) ?? 0, fit: fitFunction(demographics) };
}
