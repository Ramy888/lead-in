import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CachingClient } from "../src/qloo/cache.js";
import { FakeQlooClient } from "../src/qloo/fake.js";
import { createApp, type AppOptions } from "../src/server/app.js";
import { MemoryAgentBudget, RateLimiter } from "../src/server/limits.js";
import type { AgentModel, AgentReply } from "../src/agent/claude.js";
import { TmdbClient } from "../src/tmdb/client.js";

const servers: Array<{ close: () => void }> = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start(overrides: Partial<AppOptions> = {}) {
  const server = createApp({ qloo: new CachingClient(new FakeQlooClient()), publicDir: "public", ...overrides });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const LIB = [
  { name: "Columbo", runtimeMinutes: 76 },
  { name: "Murder, She Wrote", runtimeMinutes: 45 },
  { name: "Knight Rider", runtimeMinutes: 48 },
  { name: "Baywatch", runtimeMinutes: 42 },
  { name: "Law", runtimeMinutes: 45 },
];

async function plan(base: string, body: unknown) {
  const res = await fetch(`${base}/api/plans`, { method: "POST", body: JSON.stringify(body) });
  const text = await res.text();
  const lines = res.headers.get("content-type")?.includes("ndjson") ? text.trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { res, lines, text };
}

describe("API", () => {
  it("streams Qloo calls, then a plan that can be re-scored after a drag", async () => {
    const base = await start();
    const { res, lines } = await plan(base, { library: LIB });
    expect(res.status).toBe(200);
    const traces = lines.filter((l) => l.type === "trace");
    const final = lines.at(-1);
    expect(traces.length).toBeGreaterThan(0);
    expect(final.type).toBe("plan");
    expect(final.plan.synthetic).toBe(true);
    expect(final.plan.matrix.provenance).toBe("synthetic");
    expect(final.plan.unresolved).toMatchObject([{ name: "Law", status: "needs_input" }]);

    const seq: string[] = final.plan.schedule.slots.map((s: { showId: string }) => s.showId);
    const dragged = [...seq.slice(1), seq[0]!].reverse();
    const scored = await fetch(`${base}/api/plans/${final.plan.id}/score`, { method: "POST", body: JSON.stringify({ sequence: dragged }) });
    expect(scored.status).toBe(200);
    const body = await scored.json();
    expect(body.slots.map((s: { showId: string }) => s.showId)).toEqual(dragged);
    expect(Array.isArray(body.violations)).toBe(true);
  });

  it("rejects a re-score that adds or removes airings", async () => {
    const base = await start();
    const { lines } = await plan(base, { library: LIB });
    const p = lines.at(-1).plan;
    const seq = p.schedule.slots.map((s: { showId: string }) => s.showId);
    const res = await fetch(`${base}/api/plans/${p.id}/score`, { method: "POST", body: JSON.stringify({ sequence: seq.slice(1) }) });
    expect(res.status).toBe(400);
  });

  it("404s an unknown plan", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/plans/00000000-0000-0000-0000-000000000000/score`, {
      method: "POST", body: JSON.stringify({ sequence: [] }),
    });
    expect(res.status).toBe(404);
  });

  it("caps library size and body size, and validates year and Qloo ID", async () => {
    const base = await start({ maxShows: 3, maxBodyBytes: 2000 });
    expect((await plan(base, { library: LIB })).res.status).toBe(400);
    expect((await plan(base, { library: [{ name: "Matlock", year: 86 }] })).res.status).toBe(400);
    expect((await plan(base, { library: [{ name: "Matlock", qlooId: "../../etc" }] })).res.status).toBe(400);
    expect((await plan(base, { library: [{ name: "x".repeat(3000) }] })).res.status).toBe(413);
    expect((await plan(base, { library: [] })).res.status).toBe(400);
  });

  it("rate-limits planning per client with 429", async () => {
    const base = await start({ planLimiter: new RateLimiter(1, 0.001) });
    expect((await plan(base, { library: LIB.slice(0, 2) })).res.status).toBe(200);
    expect((await plan(base, { library: LIB.slice(0, 2) })).res.status).toBe(429);
  });

  it("serves presets and the UI, and never serves files outside public/", async () => {
    const base = await start();
    expect((await (await fetch(`${base}/api/presets`)).json())[0].library.length).toBeGreaterThan(0);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await fetch(`${base}/..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/package.json`)).status).toBe(404);
  });
});

describe("API plan store", () => {
  it("re-scores a plan after a restart when plans live in a shared store", async () => {
    // Stands in for the Durable Object's SQLite: JSON in, JSON out, outliving the server that wrote it.
    const rows = new Map<string, string>();
    const planStore = { get: (id: string) => (rows.has(id) ? JSON.parse(rows.get(id)!) : undefined), set: (id: string, p: unknown) => void rows.set(id, JSON.stringify(p)) };
    const first = await start({ planStore });
    const { lines } = await plan(first, { library: LIB });
    const made = lines.at(-1).plan;
    const restarted = await start({ planStore });
    const seq = made.schedule.slots.map((s: { showId: string }) => s.showId);
    const res = await fetch(`${restarted}/api/plans/${made.id}/score`, { method: "POST", body: JSON.stringify({ sequence: seq }) });
    expect(res.status).toBe(200);
    expect((await res.json()).flow).toBe(made.schedule.flow);
  });
});

describe("API agent", () => {
  /** Finds one bridge, tries it, adopts it. */
  const script = (): AgentModel => {
    const steps = [
      { name: "find_bridge", args: { from: "Columbo", to: "Baywatch" } },
      { name: "what_if", args: { add: [{ title: "Hart to Hart" }] } },
      { name: "finish", args: { recommendation: "Add Hart to Hart.", qloo_evidence: ["a"], our_read: ["b"], adopt_what_if: "w1" } },
    ];
    let n = 0;
    return {
      turn: async () => {
        const s = steps[n++]!;
        const message = { model: "m", content: [{ type: "tool_use", id: `toolu_${n}`, name: s.name, input: s.args }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } };
        return { message: message as unknown as AgentReply, usd: 0.01 };
      },
    };
  };
  const agentRun = (base: string, body: unknown) => fetch(`${base}/api/agent`, { method: "POST", body: JSON.stringify(body) });
  const lines = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

  it("streams Qloo calls and agent steps, then a result whose adopted day can be re-scored", async () => {
    const budget = new MemoryAgentBudget(5, 1);
    const base = await start({ agent: { model: script(), budget } });
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ agent: true });
    const out = await lines(await agentRun(base, { library: LIB.slice(0, 4), brief: "Fix Columbo into Baywatch" }));
    const types = new Set(out.map((l) => l.type));
    expect(types).toEqual(new Set(["trace", "agent_call", "agent_result_step", "agent_done"]));
    const { result } = out.at(-1);
    expect(result).toMatchObject({ recommendation: "Add Hart to Hart.", qlooEvidence: ["a"], ourRead: ["b"], usage: { llmCalls: 3, usd: 0.03 } });
    expect(result.adopted.add).toEqual(["Hart to Hart"]);
    const seq = result.adopted.plan.schedule.slots.map((s: { showId: string }) => s.showId);
    const res = await fetch(`${base}/api/plans/${result.adopted.plan.id}/score`, { method: "POST", body: JSON.stringify({ sequence: seq }) });
    expect(res.status).toBe(200);
  });

  it("starts from the day on screen: the agent's baseline flow equals the reordered day's flow", async () => {
    const base = await start({ agent: { model: script() } });
    const made = (await plan(base, { library: LIB.slice(0, 4) })).lines.at(-1).plan;
    const seq: string[] = made.schedule.slots.map((s: { showId: string }) => s.showId);
    const moved = [seq[1]!, seq[0]!, ...seq.slice(2)];
    const shown = await (await fetch(`${base}/api/plans/${made.id}/score`, { method: "POST", body: JSON.stringify({ sequence: moved }) })).json();
    const { result } = (await lines(await agentRun(base, { library: LIB.slice(0, 4), brief: "", sequence: moved }))).at(-1);
    expect(result.baselineFlow).toBe(shown.flow);
    expect((await agentRun(base, { library: LIB.slice(0, 4), sequence: ["not an id"] })).status).toBe(400);
  });

  it("is off without a model, and refuses runs once the budget or the visitor's limit is spent", async () => {
    const off = await start();
    expect(await (await fetch(`${off}/api/health`)).json()).toMatchObject({ agent: false });
    expect((await agentRun(off, { library: LIB })).status).toBe(503);

    const spent = new MemoryAgentBudget(5, 0.02);
    const base = await start({ agent: { model: script(), budget: spent } });
    await lines(await agentRun(base, { library: LIB.slice(0, 4), brief: "" })); // spends 0.03
    const refused = await agentRun(base, { library: LIB.slice(0, 4), brief: "" });
    expect(refused.status).toBe(503);
    expect((await refused.json()).error).toMatch(/budget/);

    const limited = await start({ agent: { model: script(), limiter: new RateLimiter(1, 0) } });
    await lines(await agentRun(limited, { library: LIB.slice(0, 4), brief: "" }));
    expect((await agentRun(limited, { library: LIB.slice(0, 4), brief: "" })).status).toBe(429);
  });
});

describe("API compare", () => {
  it("scores the plan against Claude alone once per plan, and works without a model too", async () => {
    let calls = 0;
    const model: AgentModel = {
      turn: async () => {
        calls++;
        const text = JSON.stringify({ schedule: ["Columbo", "Murder, She Wrote", "Knight Rider", "Baywatch"] });
        return { message: { model: "m", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } as unknown as AgentReply, usd: 0.01 };
      },
    };
    const base = await start({ agent: { model } });
    const { lines } = await plan(base, { library: LIB.slice(0, 4) });
    const id = lines.at(-1).plan.id;
    const first = await (await fetch(`${base}/api/plans/${id}/compare`, { method: "POST" })).json();
    const again = await (await fetch(`${base}/api/plans/${id}/compare`, { method: "POST" })).json();
    expect(first.aiOnly.order.length).toBeGreaterThan(0);
    expect(first.leadIn.flow).toBeGreaterThanOrEqual(first.shuffled.flow);
    expect(again).toEqual(first);
    expect(calls).toBe(1);

    const off = await start();
    const p2 = (await plan(off, { library: LIB.slice(0, 4) })).lines.at(-1).plan.id;
    const noModel = await (await fetch(`${off}/api/plans/${p2}/compare`, { method: "POST" })).json();
    expect(noModel.aiOnly).toBeUndefined();
    expect(noModel.leadIn.flow).toBeGreaterThan(0);
    expect((await fetch(`${off}/api/plans/00000000-0000-0000-0000-000000000000/compare`, { method: "POST" })).status).toBe(404);
  });
});

describe("API resilience", () => {
  it("stops calling Qloo once a plan times out, and keeps serving", async () => {
    const fake = new FakeQlooClient();
    let calls = 0;
    // Every Qloo method takes 60 ms, so a 100 ms plan times out during the second phase of lookups.
    const slowly = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A) => {
      calls++;
      await new Promise((r) => setTimeout(r, 60));
      return fn(...a);
    };
    const slow = {
      synthetic: true,
      describe: slowly(fake.describe.bind(fake)),
      recommend: slowly(fake.recommend.bind(fake)),
      audienceDemographics: slowly(fake.audienceDemographics.bind(fake)),
      affinities: slowly(fake.affinities.bind(fake)),
    };
    const base = await start({ qloo: slow, planTimeoutMs: 100 });
    const { lines } = await plan(base, { library: LIB });
    expect(lines.at(-1)).toMatchObject({ type: "error" });
    const atTimeout = calls;
    await new Promise((r) => setTimeout(r, 500));
    // Calls already in flight finish; no new Qloo calls start after the timeout (the affinity rows never run).
    expect(calls).toBe(atTimeout);
    expect(calls).toBeLessThanOrEqual(LIB.length * 2);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
});

describe("flowScore", () => {
  it("ignores stacked episodes", async () => {
    const { flowScore } = await import("../src/server/view.js");
    const slot = (showId: string, handoffScore: number) => ({ showId, startUnit: 0, units: 1, fit: 0.5, handoffScore, weakHandoff: false });
    // A→A is a stack (0.6), A→B 0.2, B→A 0.4: flow is the mean of the real handoffs only.
    expect(flowScore([slot("A", 0.6), slot("A", 0.2), slot("B", 0.4)])).toBe(0.3);
  });
});

describe("TMDB lookup for adding a show", () => {
  const tmdbStub = () => {
    let calls = 0;
    const fetchFn = (async (input: string | URL) => {
      calls++;
      const url = new URL(String(input));
      if (url.pathname === "/3/search/tv") {
        const q = url.searchParams.get("query")?.toLowerCase();
        const results = q === "columbo" ? [{ id: 1630, name: "Columbo", first_air_date: "1971-09-15", overview: "A detective.", poster_path: "/c.jpg" }] : [];
        return Response.json({ results });
      }
      if (url.pathname === "/3/tv/1630") return Response.json({ id: 1630, name: "Columbo", first_air_date: "1971-09-15", episode_run_time: [76], genres: [] });
      if (url.pathname === "/3/tv/99") return Response.json({ id: 99, name: "No runtimes", episode_run_time: [] });
      if (url.pathname === "/3/tv/99/season/1") return Response.json({ episodes: [] });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return { tmdb: new TmdbClient({ token: "t", fetchFn }), calls: () => calls };
  };

  it("searches TMDB and caches the answer, so a retyped query costs no TMDB call", async () => {
    const stub = tmdbStub();
    const base = await start({ tmdb: stub.tmdb });
    const res = await fetch(`${base}/api/tmdb/search?q=${encodeURIComponent(" Columbo ")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ tmdbId: 1630, name: "Columbo", year: 1971, overview: "A detective.", posterPath: "/c.jpg" }] });
    await fetch(`${base}/api/tmdb/search?q=columbo`);
    expect(stub.calls()).toBe(1);
    expect(await (await fetch(`${base}/api/tmdb/search?q=zzz`)).json()).toEqual({ results: [] });
  });

  it("returns a picked show's runtime, and 404 when TMDB has no runtime for it", async () => {
    const base = await start({ tmdb: tmdbStub().tmdb });
    const ok = await fetch(`${base}/api/tmdb/shows/1630`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ tmdbId: 1630, name: "Columbo", year: 1971, runtimeMinutes: 76 });
    expect((await fetch(`${base}/api/tmdb/shows/99`)).status).toBe(404);
    expect((await fetch(`${base}/api/tmdb/shows/abc`)).status).toBe(404);
  });

  it("rejects empty or overlong queries, answers 503 without TMDB, and rate-limits", async () => {
    const base = await start({ tmdb: tmdbStub().tmdb, tmdbLimiter: new RateLimiter(2, 0) });
    expect((await fetch(`${base}/api/tmdb/search?q=`)).status).toBe(400);
    expect((await fetch(`${base}/api/tmdb/search?q=${"a".repeat(101)}`)).status).toBe(400);
    expect((await fetch(`${base}/api/tmdb/search?q=columbo`)).status).toBe(429);
    const none = await start();
    expect((await fetch(`${none}/api/tmdb/search?q=columbo`)).status).toBe(503);
  });
});
