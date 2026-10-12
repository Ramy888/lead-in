import { describe, expect, it } from "vitest";
import { solve, scoreSequence, type SolverInput, type SolverShow } from "../src/solver/solve.js";

/** Deterministic PRNG so the random instances are the same on every run. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function input(shows: SolverShow[], m: Record<string, number>, overrides: Partial<SolverInput> = {}): SolverInput {
  return {
    shows,
    dayUnits: 6,
    handoff: (a, b) => m[`${a}>${b}`] ?? 0,
    fit: () => 0.5,
    maxAirings: 6,
    maxStack: 1,
    stackScore: 0,
    ...overrides,
  };
}

/** Every valid day, enumerated: the ground truth the solver is measured against. */
function bruteForceBest(inp: SolverInput): number {
  let best = -Infinity;
  const seq: string[] = [];
  const walk = (used: number) => {
    if (used === inp.dayUnits) {
      const s = scoreSequence(inp, seq);
      if (s !== null && s > best) best = s;
      return;
    }
    for (const show of inp.shows) {
      if (used + show.units > inp.dayUnits) continue;
      seq.push(show.id);
      walk(used + show.units);
      seq.pop();
    }
  };
  walk(0);
  return best;
}

describe("solve", () => {
  it("finds the known best cycle A→B→C→A when each show hands off strongly to the next", () => {
    const shows = ["A", "B", "C"].map((id) => ({ id, units: 1 }));
    const m = { "A>B": 0.9, "B>C": 0.9, "C>A": 0.9, "A>C": 0.1, "C>B": 0.1, "B>A": 0.1 };
    const result = solve(input(shows, m));
    expect(result.slots.map((s) => s.handoffScore)).toEqual([0.9, 0.9, 0.9, 0.9, 0.9, 0.9]);
  });

  it("fills the day exactly, with no gaps and no overrun", () => {
    const shows = [{ id: "A", units: 3 }, { id: "B", units: 2 }, { id: "C", units: 1 }];
    const result = solve(input(shows, { "A>B": 0.5, "B>C": 0.5, "C>A": 0.5 }, { dayUnits: 48, maxAirings: 20, maxStack: 2 }));
    expect(result.slots.reduce((n, s) => n + s.units, 0)).toBe(48);
    result.slots.forEach((s, i) => expect(s.startUnit).toBe(result.slots.slice(0, i).reduce((n, x) => n + x.units, 0)));
  });

  it("respects max airings and max stack, including across midnight wrap", () => {
    const shows = ["A", "B", "C", "D"].map((id) => ({ id, units: 2 }));
    // A is everyone's favourite: without limits it would take the whole day.
    const inp = input(shows, { "B>A": 1, "C>A": 1, "D>A": 1, "A>B": 0.2, "A>C": 0.2, "A>D": 0.2 }, {
      dayUnits: 16, maxAirings: 3, maxStack: 1, stackScore: 1,
    });
    const ids = solve(inp).slots.map((s) => s.showId);
    for (const id of ["A", "B", "C", "D"]) expect(ids.filter((x) => x === id).length).toBeLessThanOrEqual(3);
    ids.forEach((id, i) => expect(ids[(i + 1) % ids.length]).not.toBe(id));
  });

  it("is within 95% of the brute-force optimum on random small instances", () => {
    const next = rng(42);
    for (let trial = 0; trial < 25; trial++) {
      const shows = ["A", "B", "C", "D"].map((id) => ({ id, units: 1 + Math.floor(next() * 2) }));
      const m: Record<string, number> = {};
      for (const a of shows) for (const b of shows) if (a !== b) m[`${a.id}>${b.id}`] = Math.round(next() * 100) / 100;
      const fits = Object.fromEntries(shows.map((s) => [s.id, Array.from({ length: 10 }, () => next())]));
      const inp = input(shows, m, {
        dayUnits: 10, maxAirings: 4, maxStack: 2, stackScore: 0.3,
        fit: (id, unit) => fits[id]![unit]!,
      });
      const opt = bruteForceBest(inp);
      expect(solve(inp).score).toBeGreaterThanOrEqual(0.95 * opt - 1e-9);
    }
  });

  it("flags handoffs below the threshold as weak, but never a show stacking with itself", () => {
    const shows = ["A", "B"].map((id) => ({ id, units: 1 }));
    const result = solve(input(shows, { "A>B": 0.1, "B>A": 0.1 }, { dayUnits: 4, maxStack: 2, stackScore: 0.6, weakThreshold: 0.35 }));
    for (const s of result.slots) {
      const next = result.slots[(result.slots.indexOf(s) + 1) % result.slots.length]!;
      expect(s.weakHandoff).toBe(s.showId !== next.showId && s.handoffScore < 0.35);
    }
    expect(result.slots.some((s) => s.weakHandoff)).toBe(true);
  });

  it("airs every show at least minAirings times, even one that hands off badly", () => {
    const shows = ["A", "B", "C"].map((id) => ({ id, units: 1 }));
    // C is everyone's worst neighbour; without the floor the solver would drop it.
    const m = { "A>B": 0.9, "B>A": 0.9, "A>C": 0, "C>A": 0, "B>C": 0, "C>B": 0 };
    const ids = solve(input(shows, m, { dayUnits: 8, minAirings: 1 })).slots.map((s) => s.showId);
    expect(ids).toContain("C");
    expect(() => solve(input(shows, m, { dayUnits: 2, minAirings: 1 }))).toThrow(/cannot fill/i);
  });

  it("throws a clear error when the library cannot fill the day", () => {
    const inp = input([{ id: "A", units: 4 }], {}, { dayUnits: 6 });
    expect(() => solve(inp)).toThrow(/cannot fill/i);
  });
});

describe("scoreSequence", () => {
  it("rejects a sequence that breaks a constraint", () => {
    const inp = input([{ id: "A", units: 1 }, { id: "B", units: 1 }], {}, { dayUnits: 4, maxStack: 1 });
    expect(scoreSequence(inp, ["A", "A", "B", "B"])).toBeNull();
  });
});
