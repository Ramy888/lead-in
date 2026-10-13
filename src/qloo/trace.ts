// Records every Qloo call (tool, params, status, timing, result count) for the request-to-result
// walkthrough the submission requires. Params are redacted so a trace can be shown or exported safely.

import type { Demographics, DescribeHint, Entity, Envelope, QlooClient, QlooTool, Recommendation } from "./types.js";

export interface TraceEntry {
  tool: QlooTool;
  params: unknown;
  status: Envelope<unknown>["status"];
  ms: number;
  resultCount: number;
  cached?: boolean;
  errorCode?: string;
}

const SECRET_KEY_NAME = /key|token|secret|authorization|password/i;
const TOKEN_LIKE = /[A-Za-z0-9_\-]{32,}/g;
// Qloo entity IDs are UUIDs: long, but public and needed in the walkthrough.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_ENV = ["QLOO_API_KEY", "TMDB_READ_ACCESS_TOKEN", "TMDB_API_KEY", "ANTHROPIC_API_KEY"];
const registered = new Set<string>();

/** Secrets that live outside process.env (a Cloudflare Worker's env) are registered here to be masked. */
export function registerSecrets(values: Array<string | undefined>): void {
  for (const v of values) if (v && v.length >= 8) registered.add(v);
}

function secrets(): string[] {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return [...registered, ...SECRET_ENV.map((n) => env[n]).filter((v): v is string => !!v && v.length >= 8)];
}

function maskSecrets(text: string): string {
  // The configured secrets are masked by value too, whatever their shape (a key could look like a UUID).
  for (const secret of secrets()) text = text.split(secret).join("[redacted]");
  return text.replace(TOKEN_LIKE, (m) => (UUID.test(m) ? m : "[redacted]"));
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return maskSecrets(value);
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
  private cancelled = false;

  constructor(
    private readonly inner: QlooClient,
    /** Called as each call completes, so progress can stream to the UI. */
    private readonly onEntry?: (entry: TraceEntry) => void,
  ) {}

  get synthetic(): boolean {
    return this.inner.synthetic ?? false;
  }

  /** Refuse further calls: a timed-out plan must stop spending Qloo quota. */
  cancel(): void {
    this.cancelled = true;
  }

  private async record<T>(tool: QlooTool, params: unknown, call: () => Promise<Envelope<T>>): Promise<Envelope<T>> {
    if (this.cancelled) throw new Error("Planning cancelled");
    const started = performance.now();
    const env = await call();
    const entry: TraceEntry = {
      tool,
      params: redact(params),
      status: env.status,
      ms: Math.round(performance.now() - started),
      resultCount: countOf(env),
      ...(env.cached ? { cached: true } : {}),
      ...(env.error ? { errorCode: env.error.code } : {}),
    };
    this.trace.push(entry);
    this.onEntry?.(entry);
    return env;
  }

  describe(name: string, type: Entity["type"], hint?: DescribeHint): Promise<Envelope<Entity>> {
    return this.record("qloo_describe", { name, type, ...hint }, () => this.inner.describe(name, type, hint));
  }

  recommend(signals: Entity[], targetType: Entity["type"], limit: number): Promise<Envelope<Recommendation[]>> {
    const params = { signals: signals.map((s) => s.id), targetType, limit };
    return this.record("qloo_recommend", params, () => this.inner.recommend(signals, targetType, limit));
  }

  audienceDemographics(entity: Entity): Promise<Envelope<Demographics>> {
    return this.record("qloo_audience_demographics", { entity: entity.id }, () => this.inner.audienceDemographics(entity));
  }

  affinities(from: Entity, targets: Entity[]): Promise<Envelope<Recommendation[]>> {
    const params = { from: from.id, targets: targets.map((t) => t.id) };
    return this.record("qloo_rank", params, () => this.inner.affinities(from, targets));
  }
}
