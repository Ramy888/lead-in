import { describe, expect, it } from "vitest";
import { FakeQlooClient } from "../src/qloo/fake.js";
import { TracingClient, redact } from "../src/qloo/trace.js";

describe("redact", () => {
  it("masks long token-like strings and key-named fields", () => {
    const secret = "FAKE_TOKEN_0123456789abcdefghijklmnopqrstuv";
    const out = redact({ q: "Columbo", note: `Bearer ${secret}`, apiKey: "short", nested: { token: secret } });
    const text = JSON.stringify(out);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("short");
    expect(text).toContain("Columbo");
  });
});

describe("TracingClient", () => {
  it("records tool, params, status and result count for every call", async () => {
    const client = new TracingClient(new FakeQlooClient());
    const columbo = await client.describe("Columbo", "tv_show");
    expect(columbo.status).toBe("ok");
    await client.recommend([columbo.data!], "tv_show", 5);

    expect(client.trace.map((t) => t.tool)).toEqual(["qloo_describe", "qloo_recommend"]);
    expect(client.trace[1]!.status).toBe("ok");
    expect(client.trace[1]!.resultCount).toBeGreaterThan(0);
    expect(client.trace[1]!.params).toMatchObject({ targetType: "tv_show", limit: 5 });
  });

  it("surfaces needs_input with candidates instead of guessing", async () => {
    const client = new TracingClient(new FakeQlooClient());
    const res = await client.describe("Law", "tv_show");
    expect(res.status).toBe("needs_input");
    expect(res.candidates!.length).toBeGreaterThan(1);
  });
});
