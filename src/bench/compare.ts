// "Would it work the same without Qloo?" Scores Lead-In's day against days built without Qloo's audience
// data: the same Claude model scheduling from its own knowledge, the library in listed order, and
// shuffled orders. Every day is scored the same way (Qloo-derived handoffs + daypart fit), so the gap
// is what Qloo adds. The AI-only day is repaired to exactly 24 hours, and the repairs are reported.

import type { AgentModel } from "../agent/claude.js";
import type { PlanSnapshot } from "../plan-snapshot.js";
import { solverInputOf } from "../plan-snapshot.js";
import { flowScore } from "../server/view.js";
import { annotate } from "../solver/solve.js";

export interface DayMetrics {
  /** Mean handoff score between different shows (the UI's "audience flow"). */
  flow: number;
  weakHandoffs: number;
  /** Airtime-weighted mean daypart fit. */
  fit: number;
  /** Rule breaks: airings, stacks, a day that isn't exactly 24h. */
  violations: number;
}

export interface Comparison {
  leadIn: DayMetrics;
  aiOnly?: DayMetrics & { model: string; usd: number; unknownTitles: string[]; repaired: boolean; order: string[] };
  aiOnlyError?: string;
  listed: DayMetrics;
  /** Mean of `samples` shuffled days. */
  shuffled: DayMetrics & { samples: number };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function metrics(snap: PlanSnapshot, seq: string[]): DayMetrics {
  const { slots, violations } = annotate(solverInputOf(snap), seq);
  const airtime = slots.reduce((t, s) => t + s.units, 0) || 1;
  return {
    flow: flowScore(slots),
    weakHandoffs: slots.filter((s) => s.weakHandoff).length,
    fit: round(slots.reduce((t, s) => t + s.fit * s.units, 0) / airtime),
    violations: violations.length,
  };
}

function mean(ms: DayMetrics[]): DayMetrics {
  const avg = (k: keyof DayMetrics) => round(ms.reduce((t, m) => t + m[k], 0) / ms.length);
  return { flow: avg("flow"), weakHandoffs: avg("weakHandoffs"), fit: avg("fit"), violations: avg("violations") };
}

/** Loops `order` until the day is full, skipping any show that would overrun 24h. `repaired` says whether the
 *  result differs from `order` as given (looped, trimmed or with shows skipped). */
export function fillDay(snap: PlanSnapshot, order: string[]): { seq: string[]; repaired: boolean } {
  const units = new Map(snap.rules.shows.map((s) => [s.id, s.units]));
  const day = snap.rules.dayUnits;
  const seq: string[] = [];
  let used = 0;
  for (let pass = 0; pass < 6 && used < day && order.length; pass++) {
    for (const id of order) {
      const u = units.get(id) ?? 0;
      if (!u || used + u > day) continue;
      seq.push(id);
      used += u;
      if (used === day) break;
    }
  }
  const repaired = seq.length !== order.length || seq.some((x, i) => x !== order[i]);
  return { seq, repaired };
}

/** Deterministic shuffle (mulberry32), so the shuffled baseline is reproducible. */
function shuffled<T>(xs: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const AI_ONLY_PROMPT = `You are an experienced programmer for a FAST (free ad-supported streaming TV) channel.
Build a 24-hour schedule that starts at 06:00, from the shows below. Each show has a slot length in half-hours.
Goal: keep viewers watching from one show to the next (put shows whose audiences overlap next to each other), and
fit each part of the day's typical audience. Rules: every show airs at least once; at most 2 episodes of the same
show in a row; the slot lengths of all airings must add up to exactly 48 half-hours.
List airings in order. One entry is one episode and takes that show's whole slot: "Columbo" (3 half-hours) listed
once uses 3 half-hours.
Reply with JSON only: {"schedule": ["Show title", "Show title", ...]} in airing order, titles exactly as given.`;

const SCHEDULE_SCHEMA = {
  type: "object",
  properties: { schedule: { type: "array", items: { type: "string" } } },
  required: ["schedule"],
  additionalProperties: false,
};

/** The same model as the agent, scheduling from its own knowledge: no Qloo data at all. */
export async function aiOnlyDay(model: AgentModel, snap: PlanSnapshot, signal?: AbortSignal) {
  const units = new Map(snap.rules.shows.map((s) => [s.id, s.units]));
  const list = snap.shows.map((s) => `- ${s.name} (${units.get(s.id)} half-hours)`).join("\n");
  const { message, usd } = await model.turn({ system: AI_ONLY_PROMPT, tools: [], messages: [{ role: "user", content: `Shows:\n${list}` }], schema: SCHEDULE_SCHEMA }, signal);
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let titles: string[] = [];
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { schedule?: unknown };
    if (Array.isArray(parsed.schedule)) titles = parsed.schedule.map(String);
  } catch {
    // Unparseable (or a refusal): scored as an empty day, and reported.
  }
  const byName = new Map(snap.shows.map((s) => [normalize(s.name), s.id]));
  const unknownTitles: string[] = [];
  const order: string[] = [];
  for (const t of titles) {
    const id = byName.get(normalize(t));
    if (id) order.push(id);
    else unknownTitles.push(t);
  }
  return { order, unknownTitles, model: message.model, usd, parsed: titles.length > 0 };
}

export async function compareDays(snap: PlanSnapshot, model: AgentModel | null, opts: { samples?: number; signal?: AbortSignal } = {}): Promise<Comparison> {
  const samples = opts.samples ?? 50;
  const ids = snap.shows.map((s) => s.id);
  const out: Comparison = {
    leadIn: metrics(snap, snap.slots),
    listed: metrics(snap, fillDay(snap, ids).seq),
    shuffled: { ...mean(Array.from({ length: samples }, (_, i) => metrics(snap, fillDay(snap, shuffled(ids, i + 1)).seq))), samples },
  };
  if (model) {
    try {
      const ai = await aiOnlyDay(model, snap, opts.signal);
      const { seq, repaired } = fillDay(snap, ai.order);
      const names = new Map(snap.shows.map((s) => [s.id, s.name]));
      out.aiOnly = {
        ...metrics(snap, seq),
        model: ai.model,
        usd: Math.round(ai.usd * 10000) / 10000,
        unknownTitles: ai.unknownTitles.slice(0, 10),
        repaired: repaired || !ai.parsed,
        order: seq.map((id) => names.get(id) ?? id),
      };
    } catch (err) {
      out.aiOnlyError = err instanceof Error ? err.message : String(err);
    }
  }
  return out;
}
