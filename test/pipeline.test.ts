import { describe, expect, it } from "vitest";
import { planDay, unitsFor } from "../src/pipeline.js";
import { FakeQlooClient } from "../src/qloo/fake.js";

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
});
