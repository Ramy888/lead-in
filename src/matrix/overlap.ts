// Directional audience-overlap matrix: edge A→B is how much of A's audience is likely to stay for B.
// Built from Qloo insights affinities: one call per show, with the results restricted to the library.
// (The day-1 gate showed compare_audiences returns shared content tags, not an audience number.)

import type { Entity, EnvelopeStatus, QlooClient } from "../qloo/types.js";

export type Provenance = "qloo" | "synthetic";

export interface Edge {
  /** Our handoff score, 0..1: the raw affinity stretched over the range Qloo actually uses. */
  score: number;
  /** Qloo's affinity, as returned. */
  raw: number;
  provenance: Provenance;
}

export interface LookupFailure {
  from: string;
  to?: string;
  status: EnvelopeStatus;
}

/**
 * Qloo affinities are compressed. Measured on day 1: from Columbo, The Bachelor 0.76, kids' and reality
 * shows 0.78–0.84, Baywatch 0.896, Murder, She Wrote 0.974. Across the 12-show crime library the spread
 * is 0.848 (Perry Mason → Baywatch) to 0.974. Everything at or below 0.86 is a different audience, so it
 * anchors 0; the best same-niche pair anchors 1. With the 0.35 weak cut-off, a raw affinity under about
 * 0.90 is a weak handoff. Fixed anchors (not per-library min-max) keep scores comparable between
 * libraries. This is our interpretation of Qloo's numbers.
 */
export const AFFINITY_FLOOR = 0.86;
export const AFFINITY_CEIL = 0.975;

export function handoffScore(affinity: number): number {
  const s = (affinity - AFFINITY_FLOOR) / (AFFINITY_CEIL - AFFINITY_FLOOR);
  return Math.round(Math.min(1, Math.max(0, s)) * 1000) / 1000;
}

export class OverlapMatrix {
  private readonly edges = new Map<string, Edge>();
  readonly failures: LookupFailure[] = [];

  constructor(readonly ids: string[]) {}

  set(from: string, to: string, edge: Edge): void {
    if (from !== to) this.edges.set(`${from}\u0000${to}`, edge);
  }

  get(from: string, to: string): Edge | undefined {
    return this.edges.get(`${from}\u0000${to}`);
  }

  /** Score used by the solver; unknown edges count as no overlap. */
  score(from: string, to: string): number {
    return this.get(from, to)?.score ?? 0;
  }
}

const USABLE: EnvelopeStatus[] = ["ok", "partial", "degraded", "empty"];

export async function fromAffinities(client: QlooClient, shows: Entity[]): Promise<OverlapMatrix> {
  const m = new OverlapMatrix(shows.map((s) => s.id));
  const provenance: Provenance = client.synthetic ? "synthetic" : "qloo";
  // Rows are fetched concurrently; the client's throttle keeps Qloo under its rate limit.
  const rows = await Promise.all(
    shows.map(async (from) => {
      const targets = shows.filter((s) => s.id !== from.id);
      return { from, targets, res: targets.length ? await client.affinities(from, targets) : undefined };
    }),
  );
  for (const { from, targets, res } of rows) {
    if (!res) continue;
    if (!USABLE.includes(res.status)) {
      m.failures.push({ from: from.id, status: res.status });
      continue;
    }
    const affinity = new Map((res.data ?? []).map((r) => [r.entity.id, r.affinity]));
    for (const to of targets) {
      const raw = affinity.get(to.id);
      // A target Qloo didn't score is a gap in the data, not a zero.
      if (raw === undefined) m.failures.push({ from: from.id, to: to.id, status: "empty" });
      else m.set(from.id, to.id, { score: handoffScore(raw), raw, provenance });
    }
  }
  return m;
}
