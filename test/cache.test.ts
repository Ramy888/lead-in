import { describe, expect, it } from "vitest";
import { CachingClient } from "../src/qloo/cache.js";
import { FakeQlooClient } from "../src/qloo/fake.js";
import type { QlooClient } from "../src/qloo/types.js";

function counting(inner: QlooClient) {
  const calls: string[] = [];
  const client: QlooClient = {
    synthetic: true,
    describe: (n, t, h) => (calls.push("describe"), inner.describe(n, t, h)),
    recommend: (s, t, l) => (calls.push("recommend"), inner.recommend(s, t, l)),
    audienceDemographics: (e) => (calls.push("demographics"), inner.audienceDemographics(e)),
    affinities: (f, t) => (calls.push("affinities"), inner.affinities(f, t)),
  };
  return { client, calls };
}

describe("CachingClient", () => {
  it("answers a repeat call from cache and marks it", async () => {
    const { client, calls } = counting(new FakeQlooClient());
    const cache = new CachingClient(client);
    const first = await cache.describe("Columbo", "tv_show");
    const second = await cache.describe("columbo ", "tv_show");
    expect(calls).toEqual(["describe"]);
    expect(first.cached).toBeUndefined();
    expect(second).toMatchObject({ status: "ok", cached: true, data: first.data });
  });

  it("caches affinities per pair, so a grown library only asks about new pairs", async () => {
    const fake = new FakeQlooClient();
    const asked: string[][] = [];
    const { client, calls } = counting(fake);
    const inner = client.affinities;
    client.affinities = (f, t) => (asked.push(t.map((x) => x.name)), inner(f, t));
    const cache = new CachingClient(client);
    const [a, b, c] = await Promise.all(["Columbo", "Baywatch", "Matlock"].map(async (n) => (await fake.describe(n, "tv_show")).data!));
    const first = await cache.affinities(a!, [b!]);
    const grown = await cache.affinities(a!, [c!, b!]);
    const again = await cache.affinities(a!, [b!, c!]);
    expect(asked).toEqual([["Baywatch"], ["Matlock"]]);
    expect(calls).toEqual(["affinities", "affinities"]);
    expect(grown.data!.map((r) => r.entity.name).sort()).toEqual(["Baywatch", "Matlock"]);
    expect(again).toMatchObject({ status: "ok", cached: true });
    expect(again.data!.find((r) => r.entity.name === "Baywatch")!.affinity).toBe(first.data![0]!.affinity);
  });

  it("keeps a picked ID separate from a plain title lookup", async () => {
    const { client, calls } = counting(new FakeQlooClient());
    const cache = new CachingClient(client);
    await cache.describe("Law", "tv_show");
    const picked = await cache.describe("Law", "tv_show", { id: "SYN-LAW-ORDER" });
    expect(picked).toMatchObject({ status: "ok", data: { name: "Law & Order" } });
    expect(calls).toEqual(["describe", "describe"]);
  });

  it("survives a restart when given a file, and drops expired entries", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "leadin-cache-")), "qloo.json");
    const first = counting(new FakeQlooClient());
    const a = new CachingClient(first.client, 10, 60_000, file);
    await a.describe("Columbo", "tv_show");
    a.flush();
    const second = counting(new FakeQlooClient());
    const b = new CachingClient(second.client, 10, 60_000, file);
    expect(await b.describe("Columbo", "tv_show")).toMatchObject({ status: "ok", cached: true });
    expect(second.calls).toEqual([]);
    const expired = counting(new FakeQlooClient());
    const c = new CachingClient(expired.client, 10, 60_000, file);
    (c as unknown as { entries: Map<string, { expires: number }> }).entries.forEach((e) => (e.expires = 0));
    await c.describe("Columbo", "tv_show");
    expect(expired.calls).toEqual(["describe"]);
  });

  it("does not cache needs_input or errors, and stays within its bound", async () => {
    const { client, calls } = counting(new FakeQlooClient());
    const cache = new CachingClient(client, 2);
    await cache.describe("Law", "tv_show");
    await cache.describe("Law", "tv_show");
    expect(calls).toEqual(["describe", "describe"]);
    for (const n of ["Columbo", "Matlock", "Baywatch"]) await cache.describe(n, "tv_show");
    expect(cache.size).toBe(2);
  });
});
