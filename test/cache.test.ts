import { describe, expect, it } from "vitest";
import { CachingClient } from "../src/qloo/cache.js";
import { FakeQlooClient } from "../src/qloo/fake.js";
import type { QlooClient } from "../src/qloo/types.js";

function counting(inner: QlooClient) {
  const calls: string[] = [];
  const client: QlooClient = {
    synthetic: true,
    describe: (n, t) => (calls.push("describe"), inner.describe(n, t)),
    recommend: (s, t, l) => (calls.push("recommend"), inner.recommend(s, t, l)),
    audienceDemographics: (e) => (calls.push("demographics"), inner.audienceDemographics(e)),
    compareAudiences: (a, b) => (calls.push("compare"), inner.compareAudiences(a, b)),
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

  it("shares one entry for A|B and B|A compares", async () => {
    const fake = new FakeQlooClient();
    const { client, calls } = counting(fake);
    const cache = new CachingClient(client);
    const a = (await fake.describe("Columbo", "tv_show")).data!;
    const b = (await fake.describe("Baywatch", "tv_show")).data!;
    await cache.compareAudiences([a], [b]);
    await cache.compareAudiences([b], [a]);
    expect(calls).toEqual(["compare"]);
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
