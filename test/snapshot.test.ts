import { describe, expect, it } from "vitest";
import { planDay } from "../src/pipeline.js";
import { snapshotOf, solverInputOf } from "../src/plan-snapshot.js";
import { PRESETS } from "../src/presets.js";
import { FakeQlooClient } from "../src/qloo/fake.js";
import { annotate } from "../src/solver/solve.js";

describe("plan snapshots", () => {
  it("re-score an edited day exactly like the live plan, after a JSON round trip", async () => {
    const plan = await planDay(new FakeQlooClient(), PRESETS[0]!.library);
    const stored = JSON.parse(JSON.stringify(snapshotOf(plan)));
    const seq = plan.schedule.slots.map((s) => s.showId);
    // A few edits a visitor might make: swap the first two, move the last to the front, reverse.
    const edits = [[seq[1]!, seq[0]!, ...seq.slice(2)], [seq.at(-1)!, ...seq.slice(0, -1)], [...seq].reverse()];
    for (const edited of [seq, ...edits]) {
      expect(annotate(solverInputOf(stored), edited)).toEqual(annotate(plan.solverInput, edited));
    }
    expect(stored.slots).toEqual(seq);
  });
});
