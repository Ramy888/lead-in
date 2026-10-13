import { describe, expect, it } from "vitest";
import { runAgent, type AgentEvent } from "../src/agent/agent.js";
import { ClaudeModel, costOf, MODEL, type AgentMessage, type AgentModel, type AgentReply } from "../src/agent/claude.js";
import { PRESETS } from "../src/presets.js";
import { FakeQlooClient } from "../src/qloo/fake.js";
import { flowScore } from "../src/server/view.js";

type Call = { name: string; args: unknown };
type Step = Call[] | string | { refusal: true };

/** A model that plays back a script of tool calls (Claude message shape), and records what it was shown. */
function scripted(steps: Step[]) {
  const seen: AgentMessage[][] = [];
  let n = 0;
  const model: AgentModel = {
    async turn(req) {
      seen.push(structuredClone(req.messages));
      const step = steps[n++] ?? [{ name: "finish", args: { recommendation: "done", qloo_evidence: [], our_read: [] } }];
      const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const content =
        typeof step === "string"
          ? [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: step }]
          : "refusal" in step
            ? []
            : [{ type: "thinking", thinking: "", signature: "sig" }, ...step.map((c, i) => ({ type: "tool_use", id: `toolu_${n}_${i}`, name: c.name, input: c.args }))];
      const stop_reason = typeof step === "string" ? "end_turn" : "refusal" in step ? "refusal" : "tool_use";
      return { message: { id: `msg_${n}`, type: "message", role: "assistant", model: MODEL, content, stop_reason, usage } as unknown as AgentReply, usd: 0.0013 };
    },
  };
  return { model, seen, calls: () => n };
}

/** Tool results the model was sent, in order, parsed. */
const toolResults = (msgs: AgentMessage[]) =>
  msgs.flatMap((m) =>
    m.role === "user" && Array.isArray(m.content)
      ? m.content.flatMap((b) => (b.type === "tool_result" ? [JSON.parse(String(b.content))] : []))
      : [],
  );

const LIBRARY = PRESETS[0]!.library;

describe("runAgent", () => {
  it("investigates, tests a what-if and adopts it, streaming every step", async () => {
    const { model, seen } = scripted([
      [{ name: "find_bridge", args: { from: "Columbo", to: "Baywatch" } }],
      [{ name: "what_if", args: { add: [{ title: "Hart to Hart" }] } }],
      [{ name: "finish", args: { recommendation: "License Hart to Hart.", qloo_evidence: ["Qloo: overlaps both"], our_read: ["Fits late night"], adopt_what_if: "w1" } }],
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent({ model, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "Fix my weakest handoff." }, (e) => events.push(e));

    expect(result.recommendation).toBe("License Hart to Hart.");
    expect(result.qlooEvidence).toEqual(["Qloo: overlaps both"]);
    expect(result.ourRead).toEqual(["Fits late night"]);
    expect(result.adopted?.id).toBe("w1");
    expect(result.adopted?.add).toEqual(["Hart to Hart"]);
    expect(result.adopted?.plan.shows.map((s) => s.name)).toContain("Hart to Hart");
    expect(result.usage).toMatchObject({ llmCalls: 3, promptTokens: 3000, completionTokens: 300 });

    // The model saw the brief and the plan up front, and real Qloo-derived tool results afterwards.
    expect(seen[0]![0]!.content).toContain("Fix my weakest handoff.");
    expect(seen[0]![0]!.content).toContain('"weak_handoffs"');
    const [bridge, whatIf] = toolResults(seen[2]!);
    expect(bridge.bridges.length).toBeGreaterThan(0);
    expect(bridge.bridges.every((b: { title: string }) => !LIBRARY.some((l) => l.name === b.title))).toBe(true);
    expect(whatIf).toMatchObject({ id: "w1", flow_before: flowScore(result.baseline.schedule.slots) });
    expect(events.map((e) => `${e.type}:${"tool" in e ? e.tool : ""}`)).toEqual([
      "agent_call:find_bridge",
      "agent_result_step:find_bridge",
      "agent_call:what_if",
      "agent_result_step:what_if",
      "agent_call:finish",
    ]);
  });

  it("caps what-ifs and titles per what-if, telling the model why", async () => {
    const w = (title: string) => ({ name: "what_if", args: { add: [{ title }] } });
    const { model, seen } = scripted([
      [w("Hart to Hart")],
      [w("Simon & Simon")],
      [w("Silk Stalkings")],
      [w("Father Dowling Mysteries")],
      [{ name: "what_if", args: { add: [{ title: "A" }, { title: "B" }, { title: "C" }] } }],
    ]);
    const result = await runAgent({ model, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" });
    const results = toolResults(seen.at(-1)!);
    expect(results.slice(0, 3).map((r) => r.id)).toEqual(["w1", "w2", "w3"]);
    expect(results[3].error).toMatch(/What-if limit \(3\)/);
    expect(results[4].error).toMatch(/limit \(3\)/);
    expect(result.adopted).toBeNull();
  });

  it("refuses more than two added titles in one what-if", async () => {
    const { model, seen } = scripted([[{ name: "what_if", args: { add: [{ title: "Hart to Hart" }, { title: "Simon & Simon" }, { title: "Silk Stalkings" }] } }]]);
    await runAgent({ model, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" });
    expect(toolResults(seen.at(-1)!)[0].error).toMatch(/At most 2 titles/);
  });

  it("answers bad arguments, unknown tools and non-library titles with errors the model can act on", async () => {
    const { model, seen } = scripted([
      [{ name: "find_bridge", args: "not an object" }],
      [{ name: "delete_everything", args: {} }],
      [{ name: "find_bridge", args: { from: "Columbo", to: "Friends" } }],
      [{ name: "find_titles_for_daypart", args: { daypart: "Breakfast" } }],
    ]);
    await runAgent({ model, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" });
    const errors = toolResults(seen.at(-1)!).map((r) => r.error);
    expect(errors[0]).toMatch(/must be a JSON object/);
    expect(errors[1]).toMatch(/Unknown tool delete_everything/);
    expect(errors[2]).toMatch(/"Friends" is not in the library/);
    expect(errors[3]).toMatch(/Unknown daypart/);
  });

  it("stops at the step limit and falls back to the best improving what-if, saying why", async () => {
    const { model, calls } = scripted(Array.from({ length: 20 }, () => [{ name: "get_plan", args: {} }]));
    const result = await runAgent({ model, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" }, undefined, undefined, {
      maxSteps: 4,
      maxWhatIfs: 3,
      maxAddsPerWhatIf: 2,
      maxTokens: 1_000_000,
    });
    expect(calls()).toBe(4);
    expect(result.stoppedBecause).toBe("step limit (4) reached");
    expect(result.adopted).toBeNull();
  });

  it("stops when the token budget is spent", async () => {
    const { model, calls } = scripted(Array.from({ length: 20 }, () => [{ name: "get_plan", args: {} }]));
    const result = await runAgent({ model, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" }, undefined, undefined, {
      maxSteps: 20,
      maxWhatIfs: 3,
      maxAddsPerWhatIf: 2,
      maxTokens: 2500,
    });
    expect(calls()).toBe(3);
    expect(result.stoppedBecause).toMatch(/token budget/);
  });

  it("nudges a model that answers in prose instead of calling finish", async () => {
    const { model, seen } = scripted(["I think it's fine."]);
    const result = await runAgent({ model, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" });
    expect(seen[1]!.at(-1)).toEqual({ role: "user", content: "Call finish with your recommendation." });
    expect(result.recommendation).toBe("done");
  });

  it("keeps the history append-only: each reply goes back unchanged, thinking blocks included", async () => {
    const { model, seen } = scripted([
      [{ name: "get_plan", args: {} }, { name: "find_bridge", args: { from: "Columbo", to: "Baywatch" } }],
      [{ name: "get_plan", args: {} }],
    ]);
    await runAgent({ model, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" });
    // Every request starts with the previous request's messages, untouched.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.slice(0, seen[i - 1]!.length)).toEqual(seen[i - 1]);
    const firstReply = seen[1]![1]!;
    expect(firstReply.role).toBe("assistant");
    expect((firstReply.content as Array<{ type: string }>)[0]!.type).toBe("thinking");
    // Both results of a two-call turn come back in one user message.
    const results = seen[1]![2]!;
    expect((results.content as Array<{ type: string }>).map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
  });

  it("ends cleanly when the model declines", async () => {
    const { model } = scripted([{ refusal: true }]);
    const result = await runAgent({ model, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" });
    expect(result.stoppedBecause).toBe("the model declined this request");
    expect(result.adopted).toBeNull();
  });

  it("ignores an adopt_what_if id that was never tested", async () => {
    const { model } = scripted([[{ name: "finish", args: { recommendation: "x", qloo_evidence: [], our_read: [], adopt_what_if: "w9" } }]]);
    expect((await runAgent({ model, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" })).adopted).toBeNull();
  });
});

describe("ClaudeModel", () => {
  it("asks Claude Opus 5.5 with refusal fallbacks, caching and the chosen effort, and prices the answer", async () => {
    let sent: Record<string, unknown> = {};
    const reply = { id: "m", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } };
    const client = { beta: { messages: { create: async (params: Record<string, unknown>) => ((sent = params), reply) } } };
    const res = await new ClaudeModel({ apiKey: "k", effort: "high", client: client as never }).turn({ system: "s", tools: [], messages: [{ role: "user", content: "x" }] });
    expect(sent).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], cache_control: { type: "ephemeral" }, output_config: { effort: "high" } });
    expect(sent.tools).toBeUndefined();
    expect(res.usd).toBeCloseTo(1000 * 4e-6 + 5000 * 0.2e-6 + 200 * 20e-6, 12);
  });

  it("prices a fallback answer at the fallback model's rates", () => {
    const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    expect(costOf({ model: "claude-opus-4-8", usage } as never)).toBeCloseTo(1000 * 5e-6 + 1000 * 25e-6, 12);
  });
});
