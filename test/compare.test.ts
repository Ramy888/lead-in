import { describe, expect, it } from "vitest";
import type { AgentModel, AgentReply } from "../src/agent/claude.js";
import { compareDays, fillDay, metrics } from "../src/bench/compare.js";
import { planDay } from "../src/pipeline.js";
import { snapshotOf } from "../src/plan-snapshot.js";
import { PRESETS } from "../src/presets.js";
import { FakeQlooClient } from "../src/qloo/fake.js";
import { flowScore } from "../src/server/view.js";

const replying = (text: string): AgentModel => ({
  turn: async () => ({
    message: { model: "test-model", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } } as unknown as AgentReply,
    usd: 0.001,
  }),
});

describe("compareDays", async () => {
  const plan = await planDay(new FakeQlooClient(), PRESETS[0]!.library);
  const snap = JSON.parse(JSON.stringify(snapshotOf(plan)));
  const names = snap.shows.map((s: { name: string }) => s.name);

  it("scores Lead-In's own day exactly as the plan reported it", () => {
    expect(metrics(snap, snap.slots).flow).toBe(flowScore(plan.schedule.slots));
    expect(metrics(snap, snap.slots).violations).toBe(0);
  });

  it("fills an AI-only answer to exactly 24h, maps titles loosely and reports what it couldn't use", async () => {
    const reply = `Sure! {"schedule": [${[...names.map((n: string) => JSON.stringify(n.toUpperCase())), '"Seinfeld"'].join(",")}]}`;
    const c = await compareDays(snap, replying(reply), { samples: 5 });
    expect(c.aiOnly).toBeDefined();
    expect(c.aiOnly!.unknownTitles).toEqual(["Seinfeld"]);
    expect(c.aiOnly!.model).toBe("test-model");
    const units = new Map(snap.rules.shows.map((s: { id: string; units: number }) => [s.id, s.units]));
    const ids = new Map(snap.shows.map((s: { id: string; name: string }) => [s.name, s.id]));
    const total = c.aiOnly!.order.reduce((t, n) => t + (units.get(ids.get(n)!) as number), 0);
    expect(total).toBe(snap.rules.dayUnits);
  });

  it("beats unordered days on audience flow, and survives a model that returns junk", async () => {
    const c = await compareDays(snap, replying("I cannot do that."), { samples: 20 });
    expect(c.leadIn.flow).toBeGreaterThan(c.shuffled.flow);
    expect(c.leadIn.flow).toBeGreaterThanOrEqual(c.listed.flow);
    expect(c.aiOnly!.repaired).toBe(true);
    expect(c.aiOnly!.order).toEqual([]);
  });

  it("is reproducible: the shuffled baseline doesn't change between runs", async () => {
    const [a, b] = await Promise.all([compareDays(snap, null, { samples: 10 }), compareDays(snap, null, { samples: 10 })]);
    expect(a.shuffled).toEqual(b.shuffled);
    expect(a.aiOnly).toBeUndefined();
  });

  it("fillDay skips shows that would overrun the day", () => {
    const { seq } = fillDay(snap, snap.shows.map((s: { id: string }) => s.id));
    const units = new Map(snap.rules.shows.map((s: { id: string; units: number }) => [s.id, s.units]));
    expect(seq.reduce((t: number, id: string) => t + (units.get(id) as number), 0)).toBeLessThanOrEqual(snap.rules.dayUnits);
  });
});
