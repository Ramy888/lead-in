import { describe, expect, it } from "vitest";
import { RestQlooClient } from "../src/qloo/rest.js";
import type { Entity } from "../src/qloo/types.js";

// Response shapes copied from the raw day-1 calls (research/day1/raw_*.json), trimmed to the fields we read.
const COLUMBO = "66969B47-66E0-42DD-8712-99EEA147F7F1";
const MSW = "3E1285B9-7145-4BE7-9E2C-1AFFA138EE16";
const BAYWATCH = "EF24894C-73C7-4FF5-9EEA-C81F1E3AFC5F";
const ent = (entity_id: string, name: string, release_year?: number, affinity?: number) => ({
  entity_id,
  name,
  ...(release_year ? { properties: { release_year } } : {}),
  ...(affinity !== undefined ? { query: { affinity } } : {}),
});
const tv = (id: string, name: string): Entity => ({ id, name, type: "tv_show" });

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function stub(replies: Reply[] | ((url: URL) => Reply)) {
  const urls: URL[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url);
    headers.push(init?.headers as Record<string, string>);
    const r = typeof replies === "function" ? replies(url) : replies.shift() ?? { status: 500 };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const client = new RestQlooClient({ apiKey: "test-key", fetchFn, minIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms) });
  return { client, urls, headers, sleeps };
}

describe("RestQlooClient.describe", () => {
  it("resolves the one exact title even when Qloo lists others first", async () => {
    const { client, urls, headers } = stub([
      { body: { results: [ent("X", "How to Get Away with Murder", 2014), ent(MSW, "Murder, She Wrote", 1984)] } },
    ]);
    expect(await client.describe("Murder, She Wrote", "tv_show")).toEqual({
      status: "ok",
      data: { id: MSW, name: "Murder, She Wrote", year: 1984, type: "tv_show" },
    });
    expect(urls[0]!.pathname).toBe("/search");
    expect(urls[0]!.searchParams.get("types")).toBe("urn:entity:tv_show");
    // The key travels in a header, never in the URL.
    expect(headers[0]!["x-api-key"]).toBe("test-key");
    expect(urls[0]!.href).not.toContain("test-key");
  });

  it("ignores punctuation when matching titles", async () => {
    const { client } = stub([{ body: { results: [ent("D", "Diagnosis Murder", 1993)] } }]);
    expect(await client.describe("Diagnosis: Murder", "tv_show")).toMatchObject({ status: "ok", data: { id: "D" } });
  });

  it("asks which one when two shows share the title, with years as hints", async () => {
    const results = [ent("M86", "Matlock", 1986), ent("M24", "Matlock", 2024), ent("MP", "Matlock Police", 1971)];
    const { client } = stub(() => ({ body: { results } }));
    expect(await client.describe("Matlock", "tv_show")).toEqual({
      status: "needs_input",
      candidates: [
        { id: "M86", name: "Matlock", hint: "1986" },
        { id: "M24", name: "Matlock", hint: "2024" },
      ],
    });
    expect(await client.describe("Matlock", "tv_show", { year: 1986 })).toMatchObject({ status: "ok", data: { id: "M86" } });
    expect(await client.describe("Matlock", "tv_show", { id: "M24" })).toMatchObject({ status: "ok", data: { id: "M24" } });
  });

  it("offers the closest titles when nothing matches exactly, and is empty when Qloo has nothing", async () => {
    const { client } = stub([
      { body: { results: [ent("SVU", "Law & Order: Special Victims Unit", 1999), ent("LO", "Law & Order", 1990)] } },
      { body: { results: [] } },
    ]);
    expect(await client.describe("Law", "tv_show")).toMatchObject({ status: "needs_input", candidates: [{ id: "SVU" }, { id: "LO" }] });
    expect(await client.describe("Zzzz", "tv_show")).toEqual({ status: "empty" });
  });
});

describe("RestQlooClient insights", () => {
  it("scores only the requested targets for the affinity matrix", async () => {
    const { client, urls } = stub([
      { body: { success: true, results: { entities: [ent(MSW, "Murder, She Wrote", 1984, 0.9735), ent(BAYWATCH, "Baywatch", 1989, 0.896)] } } },
    ]);
    const res = await client.affinities(tv(COLUMBO, "Columbo"), [tv(MSW, "Murder, She Wrote"), tv(BAYWATCH, "Baywatch")]);
    expect(res.status).toBe("ok");
    expect(res.data!.map((r) => [r.entity.id, r.affinity])).toEqual([[MSW, 0.9735], [BAYWATCH, 0.896]]);
    const q = urls[0]!.searchParams;
    expect(urls[0]!.pathname).toBe("/v2/insights");
    expect(q.get("signal.interests.entities")).toBe(COLUMBO);
    expect(q.get("filter.results.entities")).toBe(`${MSW},${BAYWATCH}`);
    expect(q.get("take")).toBe("2");
  });

  it("reads audience demographics", async () => {
    const query = { age: { "55_and_older": -0.056, "30_to_34": 0.205 }, gender: { male: -0.241, female: 0.241 } };
    const { client, urls } = stub([{ body: { success: true, results: { demographics: [{ entity_id: COLUMBO, query }] } } }]);
    expect(await client.audienceDemographics(tv(COLUMBO, "Columbo"))).toEqual({ status: "ok", data: query });
    expect(urls[0]!.searchParams.get("filter.type")).toBe("urn:demographics");
  });
});

describe("RestQlooClient limits", () => {
  it("retries a 429 after Retry-After, then succeeds", async () => {
    const { client, sleeps } = stub([
      { status: 429, headers: { "retry-after": "2" } },
      { body: { results: [ent(COLUMBO, "Columbo", 1971)] } },
    ]);
    expect(await client.describe("Columbo", "tv_show")).toMatchObject({ status: "ok" });
    expect(sleeps).toContain(2000);
  });

  it("gives up after bounded retries with an error envelope, not a throw", async () => {
    const { client, urls } = stub(() => ({ status: 503 }));
    expect(await client.describe("Columbo", "tv_show")).toMatchObject({ status: "error", error: { code: "http_503" } });
    expect(urls).toHaveLength(4);
  });

  it("stops calling Qloo once the month's quota is down to the reserve", async () => {
    const { client, urls } = stub(() => ({ body: { results: [] }, headers: { "x-month-ratelimit-remaining": "500" } }));
    await client.describe("Columbo", "tv_show");
    expect(client.monthRemaining).toBe(500);
    expect(await client.describe("Baywatch", "tv_show")).toMatchObject({ status: "error", error: { code: "quota_reserved" } });
    expect(urls).toHaveLength(1);
  });

  it("spaces request starts so concurrent plans can't burst past 5 a second", async () => {
    const starts: number[] = [];
    const fetchFn = (async () => (starts.push(Date.now()), new Response('{"results":[]}'))) as typeof fetch;
    const client = new RestQlooClient({ apiKey: "k", fetchFn, minIntervalMs: 40 });
    await Promise.all([1, 2, 3].map(() => client.describe("x", "tv_show")));
    expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(75);
  });
});
