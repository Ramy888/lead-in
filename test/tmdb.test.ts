import { describe, expect, it } from "vitest";
import { TmdbClient } from "../src/tmdb/client.js";

/** Fetch stub keyed by URL path; records requests so auth handling can be checked. */
function stubFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const body = routes[url.pathname];
    return new Response(JSON.stringify(body ?? { status_message: "not found" }), { status: body ? 200 : 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const COLUMBO = { id: 1630, name: "Columbo", first_air_date: "1971-09-15", poster_path: "/p.jpg" };

describe("TmdbClient.importShow", () => {
  it("falls back to season episode runtimes when the show-level runtime is empty (the Columbo case)", async () => {
    const { fetchFn } = stubFetch({
      "/3/search/tv": { results: [COLUMBO] },
      "/3/tv/1630": { ...COLUMBO, episode_run_time: [], number_of_seasons: 10, genres: [{ name: "Crime" }] },
      "/3/tv/1630/season/1": { episodes: [{ runtime: 76 }, { runtime: 75 }, { runtime: 75 }, { runtime: null }] },
    });
    const show = await new TmdbClient({ token: "t", fetchFn }).importShow("Columbo");
    expect(show).toMatchObject({ tmdbId: 1630, name: "Columbo", runtimeMinutes: 75, runtimeSource: "season", year: 1971 });
  });

  it("uses the show-level runtime when TMDB has one", async () => {
    const { fetchFn, calls } = stubFetch({
      "/3/search/tv": { results: [{ id: 1, name: "Baywatch", first_air_date: "1989-04-23" }] },
      "/3/tv/1": { id: 1, name: "Baywatch", episode_run_time: [42], genres: [] },
    });
    const show = await new TmdbClient({ token: "t", fetchFn }).importShow("Baywatch");
    expect(show).toMatchObject({ runtimeMinutes: 42, runtimeSource: "show" });
    expect(calls.some((c) => c.url.includes("/season/"))).toBe(false);
  });

  it("narrows the search to the first air year when one is given", async () => {
    const { fetchFn, calls } = stubFetch({ "/3/search/tv": { results: [] } });
    await new TmdbClient({ token: "t", fetchFn }).importShow("Matlock", 1986);
    expect(new URL(calls[0]!.url).searchParams.get("first_air_date_year")).toBe("1986");
    await new TmdbClient({ token: "t", fetchFn }).importShow("Matlock");
    expect(new URL(calls[1]!.url).searchParams.has("first_air_date_year")).toBe(false);
  });

  it("returns null when nothing matches", async () => {
    const { fetchFn } = stubFetch({ "/3/search/tv": { results: [] } });
    expect(await new TmdbClient({ token: "t", fetchFn }).importShow("zzz")).toBeNull();
  });

  it("sends the read token as a bearer header, never in the URL", async () => {
    const { fetchFn, calls } = stubFetch({ "/3/search/tv": { results: [] } });
    await new TmdbClient({ token: "secret-token", fetchFn }).importShow("x");
    expect(calls[0]!.auth).toBe("Bearer secret-token");
    expect(calls[0]!.url).not.toContain("secret-token");
  });
});
