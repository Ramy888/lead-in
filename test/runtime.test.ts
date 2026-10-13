import { afterEach, describe, expect, it, vi } from "vitest";
import { RestQlooClient } from "../src/qloo/rest.js";
import { TmdbClient } from "../src/tmdb/client.js";

// Cloudflare Workers reject a global fetch called with a foreign `this` ("Illegal invocation"); Node doesn't.
// This stand-in enforces the Workers rule so the default fetch path is tested the way it runs in production.
function workersStyleFetch() {
  return vi.fn(function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify({ results: [] })));
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("default fetch under Workers rules", () => {
  it("RestQlooClient calls the global fetch without rebinding it", async () => {
    const fetchSpy = workersStyleFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const client = new RestQlooClient({ apiKey: "k", minIntervalMs: 0, maxRetries: 0 });
    expect(await client.describe("Columbo", "tv_show")).toEqual({ status: "empty" });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("TmdbClient calls the global fetch without rebinding it", async () => {
    vi.stubGlobal("fetch", workersStyleFetch());
    await expect(new TmdbClient({ token: "t" }).importShow("Columbo")).resolves.toBeNull();
  });
});
