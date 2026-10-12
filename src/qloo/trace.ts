// Records every Qloo call (tool, params, status, timing, result count) for the request-to-result
// walkthrough the submission requires. Params are redacted so a trace can be shown or exported safely.

import type { CompareResult, Demographics, Entity, Envelope, QlooClient, QlooTool, Recommendation } from "./types.js";

export interface TraceEntry {
  tool: QlooTool;
  params: unknown;
  status: Envelope<unknown>["status"];
  ms: number;
  resultCount: number;
  errorCode?: string;
}

const SECRET_KEY_NAME = /key|token|secret|authorization|password/i;
const TOKEN_LIKE = /[A-Za-z0-9_\-]{32,}/g;

export function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(TOKEN_LIKE, "[redacted]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY_NAME.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

function countOf(env: Envelope<unknown>): number {
  if (Array.isArray(env.data)) return env.data.length;
  if (env.data !== undefined) return 1;
  return env.candidates?.length ?? 0;
}

export class TracingClient implements QlooClient {
  readonly trace: TraceEntry[] = [];

  constructor(private readonly inner: QlooClient) {}

  private async record<T>(tool: QlooTool, params: unknown, call: () => Promise<Envelope<T>>): Promise<Envelope<T>> {
    const started = performance.now();
    const env = await call();
    this.trace.push({
      tool,
      params: redact(params),
      status: env.status,
      ms: Math.round(performance.now() - started),
      resultCount: countOf(env),
      ...(env.error ? { errorCode: env.error.code } : {}),
    });
    return env;
  }

  describe(name: string, type: Entity["type"]): Promise<Envelope<Entity>> {
    return this.record("qloo_describe", { name, type }, () => this.inner.describe(name, type));
  }

  recommend(signals: Entity[], targetType: Entity["type"], limit: number): Promise<Envelope<Recommendation[]>> {
    const params = { signals: signals.map((s) => s.id), targetType, limit };
    return this.record("qloo_recommend", params, () => this.inner.recommend(signals, targetType, limit));
  }

  audienceDemographics(entity: Entity): Promise<Envelope<Demographics>> {
    return this.record("qloo_audience_demographics", { entity: entity.id }, () => this.inner.audienceDemographics(entity));
  }

  compareAudiences(a: Entity[], b: Entity[]): Promise<Envelope<CompareResult>> {
    const params = { groupA: a.map((e) => e.id), groupB: b.map((e) => e.id) };
    return this.record("qloo_compare_audiences", params, () => this.inner.compareAudiences(a, b));
  }
}
