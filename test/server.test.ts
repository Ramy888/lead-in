import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CachingClient } from "../src/qloo/cache.js";
import { FakeQlooClient } from "../src/qloo/fake.js";
import { createApp, type AppOptions } from "../src/server/app.js";
import { RateLimiter } from "../src/server/limits.js";

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

  it("caps library size, compare size and body size", async () => {
    const base = await start({ maxShows: 3, maxCompareShows: 2, maxBodyBytes: 2000 });
    expect((await plan(base, { library: LIB })).res.status).toBe(400);
    expect((await plan(base, { library: LIB.slice(0, 3), matrix: "compare" })).res.status).toBe(400);
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
