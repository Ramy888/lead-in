// Real Qloo client: direct REST to the hackathon API (the same endpoints the harness calls; see
// research/day1 for the raw responses this parses). Server-side only: the key comes from the environment
// and is sent in a header, never in a URL, a log line or the trace.
//
// The hackathon key allows 5 requests a second and 10,000 a month, so every call goes through one
// shared throttle, retries are bounded, and new calls stop once the month's remainder hits a reserve
// (cached answers keep working).

import type { Demographics, DescribeHint, Entity, Envelope, QlooClient, Recommendation } from "./types.js";

export interface RestOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  /** Gap between request starts, shared by every caller. Default 250 ms (4/s, under the 5/s limit). */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Retries after a 429 or 5xx. Default 3. */
  maxRetries?: number;
  /** Refuse new calls when the month's remaining quota falls to this. Default 500. */
  monthlyReserve?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ApiEntity {
  entity_id: string;
  name: string;
  properties?: { release_year?: number };
  query?: { affinity?: number };
}

class QlooError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export class RestQlooClient implements QlooClient {
  readonly synthetic = false;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextStart = 0;
  /** Last value of x-month-ratelimit-remaining; unknown until the first response. */
  monthRemaining: number | undefined;

  constructor(private readonly opts: RestOptions) {
    if (!opts.apiKey) throw new Error("QLOO_API_KEY missing");
    this.base = opts.baseUrl ?? "https://hackathon.api.qloo.com";
    // Wrapped, not stored bare: Workers throw "Illegal invocation" if fetch is called with `this` = the client.
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Reserves the next start slot synchronously, so concurrent callers queue instead of bursting. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.nextStart);
    this.nextStart = start + (this.opts.minIntervalMs ?? 250);
    if (start > now) await this.sleep(start - now);
  }

  private async get<T>(path: string, query: Record<string, string>): Promise<T> {
    const reserve = this.opts.monthlyReserve ?? 500;
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      if (this.monthRemaining !== undefined && this.monthRemaining <= reserve) {
        throw new QlooError("quota_reserved", "Monthly Qloo quota is down to its reserve; only cached answers are served");
      }
      await this.throttle();
      const url = `${this.base}${path}?${new URLSearchParams(query)}`;
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: { "x-api-key": this.opts.apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new QlooError("network", err instanceof Error ? err.message : "Qloo unreachable");
      }
      const remaining = Number(res.headers.get("x-month-ratelimit-remaining"));
      if (res.headers.has("x-month-ratelimit-remaining") && Number.isFinite(remaining)) this.monthRemaining = remaining;
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new QlooError(res.status === 429 ? "rate_limited" : `http_${res.status}`, `Qloo ${path} answered HTTP ${res.status}`);
      return (await res.json()) as T;
    }
  }

  private async envelope<T>(call: () => Promise<Envelope<T>>): Promise<Envelope<T>> {
    try {
      return await call();
    } catch (err) {
      const code = err instanceof QlooError ? err.code : "unexpected";
      return { status: "error", error: { code, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  private toEntity(e: ApiEntity, type: Entity["type"]): Entity {
    const year = e.properties?.release_year;
    return { id: e.entity_id, name: e.name, type, ...(year ? { year } : {}) };
  }

  describe(name: string, type: Entity["type"], hint?: DescribeHint): Promise<Envelope<Entity>> {
    return this.envelope(async () => {
      const body = await this.get<{ results?: ApiEntity[] }>("/search", { query: name, types: urnOf(type), take: "10" });
      const found = (body.results ?? []).map((e) => this.toEntity(e, type));
      const ok = (e: Entity): Envelope<Entity> => ({ status: "ok", data: e });
      const ask = (es: Entity[]): Envelope<Entity> => ({
        status: "needs_input",
        candidates: es.slice(0, 5).map((e) => ({ id: e.id, name: e.name, ...(e.year ? { hint: String(e.year) } : {}) })),
      });

      if (hint?.id) {
        const picked = found.find((e) => e.id === hint.id);
        if (picked) return ok(picked);
      }
      // Exact title matches only, ignoring case and punctuation ("Diagnosis: Murder" = "Diagnosis Murder").
      // Never take the top hit blindly: "Murder, She Wrote" also returns How to Get Away with Murder.
      const exact = found.filter((e) => normalize(e.name) === normalize(name));
      if (hint?.year) {
        const sameYear = exact.filter((e) => e.year === hint.year);
        if (sameYear.length === 1) return ok(sameYear[0]!);
      }
      if (exact.length === 1) return ok(exact[0]!);
      if (exact.length > 1) return ask(exact); // Same title, different shows: Matlock 1986 and 2024.
      return found.length ? ask(found) : { status: "empty" };
    });
  }

  private async insights(query: Record<string, string>, type: Entity["type"]): Promise<Envelope<Recommendation[]>> {
    const body = await this.get<{ results?: { entities?: ApiEntity[] } }>("/v2/insights", { "filter.type": urnOf(type), ...query });
    const recs = (body.results?.entities ?? [])
      .filter((e) => typeof e.query?.affinity === "number")
      .map((e) => ({ entity: this.toEntity(e, type), affinity: e.query!.affinity! }));
    return { status: recs.length ? "ok" : "empty", data: recs };
  }

  recommend(signals: Entity[], targetType: Entity["type"], limit: number): Promise<Envelope<Recommendation[]>> {
    return this.envelope(() =>
      this.insights({ "signal.interests.entities": signals.map((s) => s.id).join(","), take: String(limit) }, targetType),
    );
  }

  affinities(from: Entity, targets: Entity[]): Promise<Envelope<Recommendation[]>> {
    return this.envelope(() =>
      this.insights(
        {
          "signal.interests.entities": from.id,
          "filter.results.entities": targets.map((t) => t.id).join(","),
          take: String(targets.length),
        },
        targets[0]?.type ?? "tv_show",
      ),
    );
  }

  audienceDemographics(entity: Entity): Promise<Envelope<Demographics>> {
    return this.envelope(async () => {
      const body = await this.get<{ results?: { demographics?: Array<{ query?: Demographics }> } }>("/v2/insights", {
        "filter.type": "urn:demographics",
        "signal.interests.entities": entity.id,
      });
      const q = body.results?.demographics?.[0]?.query;
      if (!q?.age && !q?.gender) return { status: "empty" };
      return { status: "ok", data: { age: q.age ?? {}, gender: q.gender ?? {} } };
    });
  }
}

function urnOf(type: Entity["type"]): string {
  return `urn:entity:${type === "video_game" ? "videogame" : type}`;
}
