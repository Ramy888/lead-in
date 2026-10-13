// The Lead-In API as a Web-standard handler (Request in, Response out), so one implementation runs under
// Node (server/app.ts) and in a Cloudflare Durable Object (worker/coordinator.ts).
// Public and unauthenticated by design, so judges can use it directly: every route is size-capped,
// rate-limited, and planning runs are capped in number and time. Keys live only in server-side env.

import { runAgent, type AgentResult } from "../agent/agent.js";
import type { ChatModel } from "../agent/llm.js";
import { planDay, type LibraryItem } from "../pipeline.js";
import { snapshotOf, solverInputOf, type PlanSnapshot } from "../plan-snapshot.js";
import { PRESETS } from "../presets.js";
import { TracingClient } from "../qloo/trace.js";
import type { QlooClient } from "../qloo/types.js";
import { annotate } from "../solver/solve.js";
import type { TmdbClient } from "../tmdb/client.js";
import { MemoryAgentBudget, RateLimiter, TtlStore, type AgentBudget } from "./limits.js";
import { planView, scoreView } from "./view.js";

export interface HandlerOptions {
  qloo: QlooClient;
  tmdb?: TmdbClient | null;
  maxBodyBytes?: number;
  maxShows?: number;
  maxConcurrentPlans?: number;
  planTimeoutMs?: number;
  planLimiter?: RateLimiter;
  scoreLimiter?: RateLimiter;
  /** Where plans wait to be re-scored. Default: in memory for 6 hours. */
  planStore?: PlanStore;
  /** The Nemotron agent; without it /api/agent answers 503 and the UI hides the agent. */
  agent?: { llm: ChatModel; budget?: AgentBudget; limiter?: RateLimiter; timeoutMs?: number };
}

export interface PlanStore {
  get(id: string): PlanSnapshot | undefined;
  set(id: string, plan: PlanSnapshot): void;
}

/** Handles /api/* requests. `clientKey` identifies the caller for rate limiting (an IP). */
export type ApiHandler = (req: Request, clientKey: string) => Promise<Response>;

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https://image.tmdb.org; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

/** Reads a JSON body, refusing it as soon as it passes `maxBytes` (Content-Length can't be trusted). */
async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, `Request body over ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes) || "null");
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

interface PlanRequest {
  library: Array<{ name: string; runtimeMinutes?: number; year?: number; qlooId?: string }>;
}

const QLOO_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$|^SYN-[A-Z0-9-]{1,100}$/;

function parsePlanRequest(body: unknown, maxShows: number): PlanRequest {
  const b = body as Partial<PlanRequest> | null;
  if (!b || !Array.isArray(b.library) || b.library.length === 0) throw new HttpError(400, "library must be a non-empty array");
  if (b.library.length > maxShows) throw new HttpError(400, `library is limited to ${maxShows} shows`);
  const seen = new Set<string>();
  const library: PlanRequest["library"] = [];
  for (const item of b.library) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!name || name.length > 100) throw new HttpError(400, "each show needs a name of 1–100 characters");
    const rt = item.runtimeMinutes;
    if (rt !== undefined && (!Number.isInteger(rt) || rt < 5 || rt > 240)) {
      throw new HttpError(400, "runtimeMinutes must be a whole number from 5 to 240");
    }
    const { year, qlooId } = item;
    if (year !== undefined && (!Number.isInteger(year) || year < 1900 || year > 2100)) throw new HttpError(400, "year must be a whole number from 1900 to 2100");
    if (qlooId !== undefined && (typeof qlooId !== "string" || !QLOO_ID.test(qlooId))) throw new HttpError(400, "qlooId must be a Qloo entity ID");
    const key = qlooId ?? name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    library.push({ name, ...(rt === undefined ? {} : { runtimeMinutes: rt }), ...(year ? { year } : {}), ...(qlooId ? { qlooId } : {}) });
  }
  return { library };
}

export function createHandler(opts: HandlerOptions): ApiHandler {
  const maxBody = opts.maxBodyBytes ?? 16_384;
  const maxShows = opts.maxShows ?? 40;
  const maxConcurrent = opts.maxConcurrentPlans ?? 3;
  const planTimeout = opts.planTimeoutMs ?? 120_000;
  const planLimiter = opts.planLimiter ?? new RateLimiter(5, 10);
  const scoreLimiter = opts.scoreLimiter ?? new RateLimiter(60, 120);
  const plans: PlanStore = opts.planStore ?? new TtlStore<PlanSnapshot>(200, 6 * 60 * 60 * 1000);
  const runtimes = new Map<string, number>();
  let running = 0;
  let agentsRunning = 0;
  const agentBudget = opts.agent?.budget ?? new MemoryAgentBudget();
  // Each run spends Qloo quota and Nemotron credit: 2 at once per visitor, then one every ~3 minutes.
  const agentLimiter = opts.agent?.limiter ?? new RateLimiter(2, 0.34);

  /** Fills missing runtimes from TMDB (cached); 45 min when TMDB has nothing. */
  async function withRuntimes(library: PlanRequest["library"]): Promise<LibraryItem[]> {
    const out: LibraryItem[] = [];
    for (const item of library) {
      const { runtimeMinutes, ...rest } = item;
      if (runtimeMinutes) {
        out.push({ ...rest, runtimeMinutes });
        continue;
      }
      const key = `${item.name.toLowerCase()}|${item.year ?? ""}`;
      let rt = runtimes.get(key);
      if (rt === undefined && opts.tmdb) {
        rt = (await opts.tmdb.importShow(item.name, item.year).catch(() => null))?.runtimeMinutes ?? 45;
        runtimes.set(key, rt);
      }
      out.push({ ...rest, runtimeMinutes: rt ?? 45 });
    }
    return out;
  }

  async function createPlan(req: Request, clientKey: string): Promise<Response> {
    if (!planLimiter.take(clientKey)) throw new HttpError(429, "Too many plans; try again in a minute");
    const request = parsePlanRequest(await readJson(req, maxBody), maxShows);
    if (running >= maxConcurrent) throw new HttpError(503, "Busy planning other channels; try again shortly");

    running++;
    // NDJSON stream: one line per Qloo call as it completes, then the plan (or an error line).
    const encoder = new TextEncoder();
    let closed = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => void (controller = c),
      // The visitor left. The run carries on to fill the cache, but stops writing (and still times out).
      cancel: () => void (closed = true),
    });
    const write = (line: unknown) => {
      if (!closed) controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
    };
    const client = new TracingClient(opts.qloo, (entry) => write({ type: "trace", entry }));

    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const library = await withRuntimes(request.library);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            client.cancel();
            reject(new Error("Planning took too long"));
          }, planTimeout);
        });
        const plan = await Promise.race([planDay(client, library), timeout]);
        const id = crypto.randomUUID();
        plans.set(id, snapshotOf(plan));
        write({ type: "plan", plan: planView(id, plan, client.trace) });
      } catch (err) {
        write({ type: "error", message: err instanceof Error ? err.message : "Planning failed" });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        running--;
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    })();

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
    });
  }

  async function runAgentRequest(req: Request, clientKey: string): Promise<Response> {
    const agent = opts.agent;
    if (!agent) throw new HttpError(503, "The agent isn't configured on this server");
    const blocked = agentBudget.blocked();
    if (blocked) throw new HttpError(503, blocked);
    if (!agentLimiter.take(clientKey)) throw new HttpError(429, "Too many agent runs; try again in a few minutes");
    const body = (await readJson(req, maxBody)) as { brief?: unknown } | null;
    const request = parsePlanRequest(body, maxShows);
    const brief = typeof body?.brief === "string" ? body.brief.slice(0, 500) : "";
    if (agentsRunning >= 1) throw new HttpError(503, "The agent is busy with another channel; try again shortly");

    agentsRunning++;
    agentBudget.startRun();
    const encoder = new TextEncoder();
    const abort = new AbortController();
    let closed = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const client = new TracingClient(opts.qloo, (entry) => write({ type: "trace", entry }));
    const body$ = new ReadableStream<Uint8Array>({
      start: (c) => void (controller = c),
      // Unlike a plan, a half-finished agent run has nothing worth finishing: stop spending.
      cancel: () => {
        closed = true;
        abort.abort();
        client.cancel();
      },
    });
    function write(line: unknown) {
      if (!closed) controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
    }
    // Every model call is charged to the global budget as it happens, even if the run later fails.
    const llm: ChatModel = {
      chat: async (messages, tools, signal) => {
        const res = await agent.llm.chat(messages, tools, signal);
        agentBudget.spend(res.usd);
        return res;
      },
    };

    void (async () => {
      const timer = setTimeout(() => {
        abort.abort();
        client.cancel();
      }, agent.timeoutMs ?? 120_000);
      try {
        const runtimeOf = async (item: { name: string; year?: number }) => (await withRuntimes([item]))[0]!.runtimeMinutes;
        const result = await runAgent({ llm, qloo: client, runtimeOf }, { library: (await withRuntimes(request.library)), brief }, write, abort.signal);
        write({ type: "agent_done", result: agentView(result, client) });
      } catch (err) {
        const message = abort.signal.aborted ? "The agent took too long and was stopped" : err instanceof Error ? err.message : "Agent failed";
        write({ type: "error", message });
      } finally {
        clearTimeout(timer);
        agentsRunning--;
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    })();

    return new Response(body$, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
    });
  }

  /** The agent's answer for the browser; an adopted what-if becomes a plan the grid can load and re-score. */
  function agentView(result: AgentResult, client: TracingClient) {
    let adopted = null;
    if (result.adopted) {
      const id = crypto.randomUUID();
      plans.set(id, snapshotOf(result.adopted.plan));
      adopted = { id: result.adopted.id, add: result.adopted.add, remove: result.adopted.remove, plan: planView(id, result.adopted.plan, client.trace) };
    }
    return {
      recommendation: result.recommendation,
      qlooEvidence: result.qlooEvidence,
      ourRead: result.ourRead,
      baselineFlow: planView("", result.baseline, []).schedule.flow,
      adopted,
      usage: { ...result.usage, usd: Math.round(result.usage.usd * 10000) / 10000 },
      ...(result.stoppedBecause ? { stoppedBecause: result.stoppedBecause } : {}),
    };
  }

  async function scorePlan(req: Request, clientKey: string, id: string): Promise<Response> {
    if (!scoreLimiter.take(clientKey)) throw new HttpError(429, "Too many requests");
    const plan = plans.get(id);
    if (!plan) throw new HttpError(404, "Plan not found or expired; plan the channel again");
    const body = (await readJson(req, maxBody)) as { sequence?: unknown } | null;
    const seq = body?.sequence;
    if (!Array.isArray(seq) || !seq.every((x) => typeof x === "string")) throw new HttpError(400, "sequence must be an array of show IDs");
    // Reordering only: the edited day must hold exactly the airings the plan had.
    const key = (xs: string[]) => [...xs].sort().join("\n");
    if (key(seq) !== key(plan.slots)) {
      throw new HttpError(400, "sequence must reorder the planned airings, not add or remove them");
    }
    return jsonResponse(200, scoreView(plan, annotate(solverInputOf(plan), seq)));
  }

  return async (req, clientKey) => {
    const path = new URL(req.url).pathname;
    try {
      if (req.method === "GET" && path === "/api/health") {
        return jsonResponse(200, { ok: true, synthetic: opts.qloo.synthetic ?? false, agent: !!opts.agent });
      }
      if (req.method === "GET" && path === "/api/presets") return jsonResponse(200, PRESETS);
      if (req.method === "POST" && path === "/api/plans") return await createPlan(req, clientKey);
      if (req.method === "POST" && path === "/api/agent") return await runAgentRequest(req, clientKey);
      const score = path.match(/^\/api\/plans\/([0-9a-f-]{36})\/score$/);
      if (req.method === "POST" && score) return await scorePlan(req, clientKey, score[1]!);
      throw new HttpError(404, "Not found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return jsonResponse(status, { error: err instanceof HttpError ? err.message : "Internal error" });
    }
  };
}
