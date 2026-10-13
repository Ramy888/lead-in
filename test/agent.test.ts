import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent, type AgentEvent } from "../src/agent/agent.js";
import { NemotronClient, SUPER, ULTRA, type ChatMessage, type ChatModel, type ChatResult } from "../src/agent/llm.js";
import { PRESETS } from "../src/presets.js";
import { FakeQlooClient } from "../src/qloo/fake.js";
import { flowScore } from "../src/server/view.js";

type Step = Array<{ name: string; args: unknown } | { raw: string; name: string }> | string;

/** A model that plays back a script of tool calls, and records what it was shown. */
function scripted(steps: Step[]) {
  const seen: ChatMessage[][] = [];
  let n = 0;
  const llm: ChatModel = {
    async chat(messages): Promise<ChatResult> {
      seen.push(structuredClone(messages));
      const step = steps[n++] ?? [{ name: "finish", args: { recommendation: "done", qloo_evidence: [], our_read: [] } }];
      const base = { model: ULTRA, promptTokens: 1000, completionTokens: 100, usd: 0.0013 };
      if (typeof step === "string") return { ...base, content: step, toolCalls: [] };
      return {
        ...base,
        content: "",
        toolCalls: step.map((c, i) => ({
          id: `call-${n}-${i}`,
          type: "function" as const,
          function: { name: c.name, arguments: "raw" in c ? c.raw : JSON.stringify(c.args) },
        })),
      };
    },
  };
  return { llm, seen, calls: () => n };
}

const LIBRARY = PRESETS[0]!.library;
const toolResults = (msgs: ChatMessage[]) => msgs.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));

describe("runAgent", () => {
  it("investigates, tests a what-if and adopts it, streaming every step", async () => {
    const { llm, seen } = scripted([
      [{ name: "find_bridge", args: { from: "Columbo", to: "Baywatch" } }],
      [{ name: "what_if", args: { add: [{ title: "Hart to Hart" }] } }],
      [{ name: "finish", args: { recommendation: "License Hart to Hart.", qloo_evidence: ["Qloo: overlaps both"], our_read: ["Fits late night"], adopt_what_if: "w1" } }],
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent({ llm, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "Fix my weakest handoff." }, (e) => events.push(e));

    expect(result.recommendation).toBe("License Hart to Hart.");
    expect(result.qlooEvidence).toEqual(["Qloo: overlaps both"]);
    expect(result.ourRead).toEqual(["Fits late night"]);
    expect(result.adopted?.id).toBe("w1");
    expect(result.adopted?.add).toEqual(["Hart to Hart"]);
    expect(result.adopted?.plan.shows.map((s) => s.name)).toContain("Hart to Hart");
    expect(result.usage).toMatchObject({ llmCalls: 3, promptTokens: 3000, completionTokens: 300 });

    // The model saw the brief and the plan up front, and real Qloo-derived tool results afterwards.
    expect(seen[0]![1]!.content).toContain("Fix my weakest handoff.");
    expect(seen[0]![1]!.content).toContain('"weak_handoffs"');
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
    const { llm, seen } = scripted([
      [w("Hart to Hart")],
      [w("Simon & Simon")],
      [w("Silk Stalkings")],
      [w("Father Dowling Mysteries")],
      [{ name: "what_if", args: { add: [{ title: "A" }, { title: "B" }, { title: "C" }] } }],
    ]);
    const result = await runAgent({ llm, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" });
    const results = toolResults(seen.at(-1)!);
    expect(results.slice(0, 3).map((r) => r.id)).toEqual(["w1", "w2", "w3"]);
    expect(results[3].error).toMatch(/What-if limit \(3\)/);
    expect(results[4].error).toMatch(/limit \(3\)/);
    expect(result.adopted).toBeNull();
  });

  it("refuses more than two added titles in one what-if", async () => {
    const { llm, seen } = scripted([[{ name: "what_if", args: { add: [{ title: "Hart to Hart" }, { title: "Simon & Simon" }, { title: "Silk Stalkings" }] } }]]);
    await runAgent({ llm, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" });
    expect(toolResults(seen.at(-1)!)[0].error).toMatch(/At most 2 titles/);
  });

  it("answers bad arguments, unknown tools and non-library titles with errors the model can act on", async () => {
    const { llm, seen } = scripted([
      [{ name: "find_bridge", raw: "{not json" }],
      [{ name: "delete_everything", args: {} }],
      [{ name: "find_bridge", args: { from: "Columbo", to: "Friends" } }],
      [{ name: "find_titles_for_daypart", args: { daypart: "Breakfast" } }],
    ]);
    await runAgent({ llm, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" });
    const errors = toolResults(seen.at(-1)!).map((r) => r.error);
    expect(errors[0]).toMatch(/not valid JSON/);
    expect(errors[1]).toMatch(/Unknown tool delete_everything/);
    expect(errors[2]).toMatch(/"Friends" is not in the library/);
    expect(errors[3]).toMatch(/Unknown daypart/);
  });

  it("stops at the step limit and falls back to the best improving what-if, saying why", async () => {
    const { llm, calls } = scripted(Array.from({ length: 20 }, () => [{ name: "get_plan", args: {} }]));
    const result = await runAgent({ llm, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" }, undefined, undefined, {
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
    const { llm, calls } = scripted(Array.from({ length: 20 }, () => [{ name: "get_plan", args: {} }]));
    const result = await runAgent({ llm, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" }, undefined, undefined, {
      maxSteps: 20,
      maxWhatIfs: 3,
      maxAddsPerWhatIf: 2,
      maxTokens: 2500,
    });
    expect(calls()).toBe(3);
    expect(result.stoppedBecause).toMatch(/token budget/);
  });

  it("nudges a model that answers in prose instead of calling finish", async () => {
    const { llm, seen } = scripted(["I think it's fine."]);
    const result = await runAgent({ llm, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" });
    expect(seen[1]!.at(-1)).toEqual({ role: "user", content: "Call finish with your recommendation." });
    expect(result.recommendation).toBe("done");
  });

  it("ignores an adopt_what_if id that was never tested", async () => {
    const { llm } = scripted([[{ name: "finish", args: { recommendation: "x", qloo_evidence: [], our_read: [], adopt_what_if: "w9" } }]]);
    expect((await runAgent({ llm, qloo: new FakeQlooClient() }, { library: LIBRARY, brief: "" })).adopted).toBeNull();
  });
});

describe("NemotronClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = (model: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content: "hi", tool_calls: [] } }], usage: { prompt_tokens: 1000, completion_tokens: 200 }, model }));

  it("sends the key as a bearer header, prices the call, and falls back to the next model on 429", async () => {
    const calls: Array<{ url: string; auth: string; model: string }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      calls.push({ url: String(url), auth: (init!.headers as Record<string, string>).Authorization!, model: body.model });
      return body.model === ULTRA ? new Response("{}", { status: 429 }) : reply(body.model);
    }) as typeof fetch;
    const res = await new NemotronClient({ apiKey: "nb-key", fetchFn }).chat([{ role: "user", content: "x" }], []);
    expect(calls.map((c) => c.model)).toEqual([ULTRA, SUPER]);
    expect(calls[0]!.auth).toBe("Bearer nb-key");
    expect(calls[0]!.url).not.toContain("nb-key");
    expect(res.model).toBe(SUPER);
    expect(res.usd).toBeCloseTo(1000 * 0.3e-6 + 200 * 0.9e-6, 12);
  });

  it("throws when every model fails", async () => {
    const fetchFn = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    await expect(new NemotronClient({ apiKey: "k", fetchFn }).chat([], [])).rejects.toThrow(/Nemotron unavailable/);
  });

  it("calls the global fetch the way Workers require", async () => {
    const spy = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(reply(ULTRA));
    });
    vi.stubGlobal("fetch", spy);
    await expect(new NemotronClient({ apiKey: "k" }).chat([], [])).resolves.toMatchObject({ model: ULTRA });
  });
});
