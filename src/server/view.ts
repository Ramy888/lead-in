// The JSON the browser gets. Every number is tagged with where it came from: Qloo (or the synthetic
// stand-in) versus our own interpretation (daypart profiles, thresholds, fit).

import type { Plan } from "../pipeline.js";
import type { TraceEntry } from "../qloo/trace.js";
import { DAYPARTS, daypartAt, formatTime, unitToHour } from "../solver/dayparts.js";
import type { Annotated, Slot } from "../solver/solve.js";

export interface SlotView extends Slot {
  name: string;
  time: string;
  daypart: string;
}

export function slotViews(plan: Plan, slots: Slot[]): SlotView[] {
  const names = new Map(plan.shows.map((s) => [s.id, s.name]));
  return slots.map((slot) => ({
    ...slot,
    name: names.get(slot.showId) ?? slot.showId,
    time: formatTime(slot.startUnit),
    daypart: daypartAt(unitToHour(slot.startUnit)).name,
  }));
}

/** Mean handoff between different shows: the "audience flow" number the UI headlines. Stacked episodes are
 *  left out so a stack-heavy day can't look better than its real handoffs. */
export function flowScore(slots: Slot[]): number {
  const handoffs = slots.filter((s, i) => s.showId !== slots[(i + 1) % slots.length]!.showId);
  if (!handoffs.length) return 0;
  return Math.round((handoffs.reduce((t, s) => t + s.handoffScore, 0) / handoffs.length) * 1000) / 1000;
}

export function planView(id: string, plan: Plan, trace: TraceEntry[]) {
  const ids = plan.shows.map((s) => s.id);
  return {
    id,
    synthetic: plan.synthetic,
    shows: plan.shows.map((s) => ({ ...s, demographics: plan.demographics.get(s.id) ?? null })),
    unresolved: plan.unresolved,
    notAired: plan.notAired,
    matrix: {
      ids,
      provenance: plan.matrix.get(ids[0] ?? "", ids[1] ?? "")?.provenance ?? null,
      // scores[i][j] = our handoff score from show i to show j; raw[i][j] = the Qloo affinity behind it.
      // null where Qloo gave nothing.
      scores: ids.map((a) => ids.map((b) => (a === b ? null : plan.matrix.get(a, b)?.score ?? null))),
      raw: ids.map((a) => ids.map((b) => (a === b ? null : plan.matrix.get(a, b)?.raw ?? null))),
      failures: plan.matrix.failures,
    },
    schedule: {
      flow: flowScore(plan.schedule.slots),
      slots: slotViews(plan, plan.schedule.slots),
      violations: [] as string[],
    },
    gaps: plan.gaps,
    license: plan.license,
    dayparts: DAYPARTS.map((d) => ({ name: d.name, startHour: d.startHour, endHour: d.endHour })),
    rules: {
      weakHandoff: plan.solverInput.weakThreshold ?? 0.35,
      maxAirings: plan.solverInput.maxAirings,
      minAirings: plan.solverInput.minAirings ?? 0,
      maxStack: plan.solverInput.maxStack,
    },
    trace,
  };
}

export function scoreView(plan: Plan, annotated: Annotated) {
  const names = new Map(plan.shows.map((s) => [s.id, s.name]));
  // Violations name show IDs; swap in titles for display.
  const violations = annotated.violations.map((v) => v.replace(/^\S+/, (id) => names.get(id) ?? id));
  return { flow: flowScore(annotated.slots), slots: slotViews(plan, annotated.slots), violations };
}
