// Directional audience-overlap matrix: edge A→B is how much of A's audience is likely to stay for B.
// Two builders, picked by the day-1 gate: compare_audiences (symmetric) or recommend affinities (asymmetric).

import type { Entity, EnvelopeStatus, QlooClient } from "../qloo/types.js";

export type Provenance = "compare" | "recommend" | "synthetic";

export interface Edge {
  score: number;
  provenance: Provenance;
}

export interface LookupFailure {
  from: string;
  to?: string;
  status: EnvelopeStatus;
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

export async function fromRecommend(client: QlooClient, shows: Entity[], limit = 50): Promise<OverlapMatrix> {
  const m = new OverlapMatrix(shows.map((s) => s.id));
  for (const from of shows) {
    const res = await client.recommend([from], "tv_show", limit);
    if (!USABLE.includes(res.status)) {
      m.failures.push({ from: from.id, status: res.status });
      continue;
    }
    const affinity = new Map((res.data ?? []).map((r) => [r.entity.id, r.affinity]));
    for (const to of shows) m.set(from.id, to.id, { score: affinity.get(to.id) ?? 0, provenance: "recommend" });
  }
  return m;
}

export async function fromCompare(client: QlooClient, shows: Entity[]): Promise<OverlapMatrix> {
  const m = new OverlapMatrix(shows.map((s) => s.id));
  for (let i = 0; i < shows.length; i++) {
    for (let j = i + 1; j < shows.length; j++) {
      const a = shows[i]!, b = shows[j]!;
      const res = await client.compareAudiences([a], [b]);
      if (res.status !== "ok" && res.status !== "partial" && res.status !== "degraded") {
        m.failures.push({ from: a.id, to: b.id, status: res.status });
        continue;
      }
      const edge: Edge = { score: res.data!.overlap, provenance: "compare" };
      m.set(a.id, b.id, edge);
      m.set(b.id, a.id, edge);
    }
  }
  return m;
}
