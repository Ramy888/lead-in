import { describe, expect, it } from "vitest";
import { FakeQlooClient } from "../src/qloo/fake.js";
import type { Entity, Envelope, QlooClient, Recommendation } from "../src/qloo/types.js";
import { fromCompare, fromRecommend } from "../src/matrix/overlap.js";

const show = (id: string): Entity => ({ id, name: id, type: "tv_show" });
const A = show("A"), B = show("B"), C = show("C");

/** Client whose recommend lists are scripted per signal, to pin down the matrix maths. */
function scripted(lists: Record<string, Array<[string, number]>>, status: Envelope<unknown>["status"] = "ok"): QlooClient {
  const fake = new FakeQlooClient();
  return {
    describe: fake.describe.bind(fake),
    audienceDemographics: fake.audienceDemographics.bind(fake),
    compareAudiences: async () => ({ status: "ok", data: { overlap: 0.5 } }),
    recommend: async (signals): Promise<Envelope<Recommendation[]>> => ({
      status,
      data: (lists[signals[0]!.id] ?? []).map(([id, affinity]) => ({ entity: show(id), affinity })),
    }),
  };
}

describe("fromRecommend", () => {
  it("is directional: A→B comes from A's list, B→A from B's", async () => {
    const m = await fromRecommend(scripted({ A: [["B", 0.9]], B: [["A", 0.2]] }), [A, B]);
    expect(m.get("A", "B")).toMatchObject({ score: 0.9, provenance: "recommend" });
    expect(m.get("B", "A")).toMatchObject({ score: 0.2, provenance: "recommend" });
  });

  it("scores a pair missing from the list as 0 but keeps provenance", async () => {
    const m = await fromRecommend(scripted({ A: [["B", 0.9]] }), [A, B, C]);
    expect(m.get("A", "C")).toMatchObject({ score: 0, provenance: "recommend" });
  });

  it("records failed lookups instead of silently scoring them 0", async () => {
    const m = await fromRecommend(scripted({}, "error"), [A, B]);
    expect(m.get("A", "B")).toBeUndefined();
    expect(m.failures).toEqual([{ from: "A", status: "error" }, { from: "B", status: "error" }]);
  });
});

describe("fromCompare", () => {
  it("fills both directions from one symmetric score", async () => {
    const fake = new FakeQlooClient();
    const ids = await Promise.all(["Columbo", "Murder, She Wrote", "Baywatch"].map((n) => fake.describe(n, "tv_show")));
    const [col, msw, bay] = ids.map((e) => e.data!);
    const m = await fromCompare(fake, [col!, msw!, bay!]);
    expect(m.get(col!.id, msw!.id)!.score).toBe(m.get(msw!.id, col!.id)!.score);
    // Fake data must never be labelled as Qloo's.
    expect(m.get(col!.id, msw!.id)!.provenance).toBe("synthetic");
    // The synthetic data must keep the day-1 intuition: a close pair beats a far pair.
    expect(m.get(col!.id, msw!.id)!.score).toBeGreaterThan(m.get(col!.id, bay!.id)!.score);
  });

  it("labels edges from a real client as compare", async () => {
    const m = await fromCompare(scripted({}), [A, B]);
    expect(m.get("A", "B")).toMatchObject({ score: 0.5, provenance: "compare" });
  });

  it("never stores a self edge", async () => {
    const m = await fromCompare(scripted({}), [A, B]);
    expect(m.get("A", "A")).toBeUndefined();
  });
});
