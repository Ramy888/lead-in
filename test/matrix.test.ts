import { describe, expect, it } from "vitest";
import { FakeQlooClient } from "../src/qloo/fake.js";
import type { Entity, Envelope, QlooClient, Recommendation } from "../src/qloo/types.js";
import { fromAffinities, handoffScore } from "../src/matrix/overlap.js";

const show = (id: string): Entity => ({ id, name: id, type: "tv_show" });
const A = show("A"), B = show("B"), C = show("C");

/** Client whose affinity rows are scripted per signal, to pin down the matrix maths. */
function scripted(rows: Record<string, Array<[string, number]>>, status: Envelope<unknown>["status"] = "ok"): QlooClient {
  const fake = new FakeQlooClient();
  return {
    describe: fake.describe.bind(fake),
    audienceDemographics: fake.audienceDemographics.bind(fake),
    recommend: fake.recommend.bind(fake),
    affinities: async (from): Promise<Envelope<Recommendation[]>> => ({
      status,
      data: (rows[from.id] ?? []).map(([id, affinity]) => ({ entity: show(id), affinity })),
    }),
  };
}

describe("handoffScore", () => {
  it("stretches Qloo's compressed band to 0..1 and clamps outside it", () => {
    expect(handoffScore(0.975)).toBe(1);
    expect(handoffScore(0.86)).toBe(0);
    expect(handoffScore(0.76)).toBe(0);
    expect(handoffScore(0.99)).toBe(1);
    // Day-1 numbers: Columbo→Murder, She Wrote is a strong handoff, Columbo→Baywatch a weak one (< 0.35).
    expect(handoffScore(0.9735)).toBeGreaterThan(0.95);
    expect(handoffScore(0.896)).toBeLessThan(0.35);
  });
});

describe("fromAffinities", () => {
  it("is directional and keeps the raw Qloo affinity beside our score", async () => {
    const m = await fromAffinities(scripted({ A: [["B", 0.95]], B: [["A", 0.85]] }), [A, B]);
    expect(m.get("A", "B")).toEqual({ score: handoffScore(0.95), raw: 0.95, provenance: "qloo" });
    expect(m.get("B", "A")).toEqual({ score: handoffScore(0.85), raw: 0.85, provenance: "qloo" });
  });

  it("never asks Qloo about a show's affinity for itself", async () => {
    const asked: string[][] = [];
    const c = scripted({});
    const inner = c.affinities;
    c.affinities = (from, targets) => (asked.push(targets.map((t) => t.id)), inner(from, targets));
    const m = await fromAffinities(c, [A, B, C]);
    expect(asked).toEqual([["B", "C"], ["A", "C"], ["A", "B"]]);
    expect(m.get("A", "A")).toBeUndefined();
  });

  it("records a target Qloo didn't score as a failure, not a zero", async () => {
    const m = await fromAffinities(scripted({ A: [["B", 0.9]] }), [A, B, C]);
    expect(m.get("A", "C")).toBeUndefined();
    expect(m.failures).toContainEqual({ from: "A", to: "C", status: "empty" });
  });

  it("records failed lookups", async () => {
    const m = await fromAffinities(scripted({}, "error"), [A, B]);
    expect(m.get("A", "B")).toBeUndefined();
    expect(m.failures).toEqual([{ from: "A", status: "error" }, { from: "B", status: "error" }]);
  });

  it("labels synthetic data and keeps the day-1 intuition", async () => {
    const fake = new FakeQlooClient();
    const [col, msw, bay] = (await Promise.all(["Columbo", "Murder, She Wrote", "Baywatch"].map((n) => fake.describe(n, "tv_show")))).map(
      (e) => e.data!,
    );
    const m = await fromAffinities(fake, [col!, msw!, bay!]);
    expect(m.get(col!.id, msw!.id)!.provenance).toBe("synthetic");
    expect(m.get(col!.id, msw!.id)!.score).toBeGreaterThan(m.get(col!.id, bay!.id)!.score);
  });
});
