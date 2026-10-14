import { describe, expect, it, vi } from "vitest";
import { handoffScore } from "../src/matrix/overlap.js";
import { planDay, unitsFor } from "../src/pipeline.js";
import { FakeQlooClient } from "../src/qloo/fake.js";
import { PRESETS } from "../src/presets.js";

const LIBRARY = [
  { name: "Columbo", runtimeMinutes: 76 },
  { name: "Murder, She Wrote", runtimeMinutes: 45 },
  { name: "Matlock", runtimeMinutes: 48 },
  { name: "Knight Rider", runtimeMinutes: 48 },
  { name: "Baywatch", runtimeMinutes: 42 },
  { name: "Law", runtimeMinutes: 45 },
];

describe("unitsFor", () => {
  it("rounds runtime plus ad load up to half-hour slots", () => {
    expect([unitsFor(22), unitsFor(42), unitsFor(45), unitsFor(76)]).toEqual([1, 2, 2, 3]);
  });
});

describe("planDay", () => {
  it("airs every resolved show and reports ambiguous names with candidates", async () => {
    const plan = await planDay(new FakeQlooClient(), LIBRARY);
    const aired = new Set(plan.schedule.slots.map((s) => s.showId));
    expect(plan.shows.every((s) => aired.has(s.id))).toBe(true);
    expect(plan.unresolved).toMatchObject([{ name: "Law", status: "needs_input" }]);
    expect(plan.schedule.slots.reduce((n, s) => n + s.units, 0)).toBe(48);
    expect(plan.synthetic).toBe(true);
  });

  it("suggests only titles outside the library for weak dayparts", async () => {
    const plan = await planDay(new FakeQlooClient(), LIBRARY, { gapThreshold: 1.01 });
    expect(plan.gaps.length).toBeGreaterThan(0);
    expect(plan.license.length).toBeGreaterThan(0);
    const library = new Set(plan.shows.map((s) => s.id));
    expect(plan.license.every((l) => !library.has(l.title.id))).toBe(true);
    // The shown match is the mapped affinity, and each daypart's list is ranked on fit × match.
    for (const l of plan.license) expect(l.match).toBe(handoffScore(l.affinity));
    for (const d of new Set(plan.license.map((l) => l.daypart))) {
      const rank = plan.license.filter((l) => l.daypart === d).map((l) => l.fit * l.match);
      expect(rank).toEqual([...rank].sort((a, b) => b - a));
    }
  });
});

describe("planDay with a library longer than a day", () => {
  it("fills the day and lists what didn't air instead of failing", async () => {
    // Seven 4-hour blocks (8 units each) = 56 units of library for a 48-unit day.
    const names = ["Columbo", "Matlock", "Knight Rider", "Baywatch", "Perry Mason", "The A-Team", "Magnum, P.I."];
    const library = names.map((name) => ({ name, runtimeMinutes: 200 }));
    const plan = await planDay(new FakeQlooClient(), library, { maxAirings: 1, maxStack: 1 });
    expect(plan.schedule.slots.reduce((n, s) => n + s.units, 0)).toBe(48);
    expect(plan.notAired).toHaveLength(1);
  });

  it("says Qloo is unreachable when every lookup failed, not that the library is too small", async () => {
    const fake = new FakeQlooClient();
    const down = {
      describe: async () => ({ status: "error" as const, error: { code: "network", message: "down" } }),
      recommend: fake.recommend.bind(fake),
      audienceDemographics: fake.audienceDemographics.bind(fake),
      affinities: fake.affinities.bind(fake),
    };
    await expect(planDay(down, LIBRARY)).rejects.toThrow(/Qloo couldn't be reached/);
  });
});

describe("planDay with a given order (the day on screen)", () => {
  it("keeps that exact order instead of re-solving, and derives gaps from it", async () => {
    const lib = LIBRARY.filter((s) => s.name !== "Law");
    const first = await planDay(new FakeQlooClient(), lib);
    const order = first.schedule.slots.map((s) => s.showId);
    const moved = [order[1]!, order[0]!, ...order.slice(2)]; // a manual swap
    const again = await planDay(new FakeQlooClient(), lib, { order: moved });
    expect(again.schedule.slots.map((s) => s.showId)).toEqual(moved);
  });

  it("re-solves when the order doesn't cover exactly the library's shows", async () => {
    const lib = LIBRARY.filter((s) => s.name !== "Law");
    const first = await planDay(new FakeQlooClient(), lib);
    const order = first.schedule.slots.map((s) => s.showId);
    const stale = order.filter((id) => id !== order[0]); // a show missing: the library changed since
    const again = await planDay(new FakeQlooClient(), lib, { order: stale });
    expect(again.schedule.slots.map((s) => s.showId)).toEqual(order);
  });
});

describe("planDay is reproducible for demo-size libraries", () => {
  it("gives the same day on a slow or busy machine as on an idle one", async () => {
    const lib = PRESETS[0]!.library; // Classic Crime & Action: its polishing takes longer than the old 1.5 s cap
    const idle = await planDay(new FakeQlooClient(), lib, { budgetMs: Infinity });
    const realNow = performance.now.bind(performance);
    let skew = 0;
    // A busy machine: every clock read looks 2 s later than the last.
    vi.spyOn(performance, "now").mockImplementation(() => realNow() + (skew += 2000));
    try {
      const busy = await planDay(new FakeQlooClient(), lib);
      expect(busy.schedule.slots.map((s) => s.showId)).toEqual(idle.schedule.slots.map((s) => s.showId));
    } finally {
      vi.restoreAllMocks();
    }
  }, 60_000);
});
