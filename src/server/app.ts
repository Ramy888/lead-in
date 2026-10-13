// HTTP API + static UI in one Node process (the Qloo harness needs a long-lived container anyway).
// Public and unauthenticated by design, so judges can use it directly: every route is size-capped,
// rate-limited, and planning runs are capped in number and time. Keys live only in process.env.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { planDay, type LibraryItem, type Plan } from "../pipeline.js";
import { PRESETS } from "../presets.js";
import { TracingClient } from "../qloo/trace.js";
import type { QlooClient } from "../qloo/types.js";
import { annotate } from "../solver/solve.js";
import type { TmdbClient } from "../tmdb/client.js";
import { RateLimiter, TtlStore } from "./limits.js";
import { planView, scoreView } from "./view.js";

export interface AppOptions {
  qloo: QlooClient;
  tmdb?: TmdbClient | null;
  publicDir: string;
  /** Use the proxy's client-IP header for rate limiting (Fly/Render). Off when not behind a proxy. */
  trustProxy?: boolean;
  maxBodyBytes?: number;
  maxShows?: number;
  maxConcurrentPlans?: number;
  planTimeoutMs?: number;
  planLimiter?: RateLimiter;
  scoreLimiter?: RateLimiter;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https://image.tmdb.org; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, `Request body over ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
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

export function createApp(opts: AppOptions): Server {
  const maxBody = opts.maxBodyBytes ?? 16_384;
  const maxShows = opts.maxShows ?? 40;
  const maxConcurrent = opts.maxConcurrentPlans ?? 3;
  const planTimeout = opts.planTimeoutMs ?? 120_000;
  const planLimiter = opts.planLimiter ?? new RateLimiter(5, 10);
  const scoreLimiter = opts.scoreLimiter ?? new RateLimiter(60, 120);
  const plans = new TtlStore<Plan>(200, 6 * 60 * 60 * 1000);
  const runtimes = new Map<string, number>();
  const publicDir = resolve(opts.publicDir);
  let running = 0;

  const clientKey = (req: IncomingMessage): string => {
    if (opts.trustProxy) {
      const fwd = (req.headers["fly-client-ip"] ?? req.headers["x-forwarded-for"]) as string | undefined;
      if (fwd) return fwd.split(",")[0]!.trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  /** Fills missing runtimes from TMDB (cached); 45 min when TMDB has nothing. */
  async function withRuntimes(library: PlanRequest["library"]): Promise<LibraryItem[]> {
    const out: LibraryItem[] = [];
    for (const item of library) {
      const { runtimeMinutes, ...rest } = item;
      if (runtimeMinutes) {
        out.push({ ...rest, runtimeMinutes });
        continue;
      }
      const key = item.name.toLowerCase();
      let rt = runtimes.get(key);
      if (rt === undefined && opts.tmdb) {
        rt = (await opts.tmdb.importShow(item.name).catch(() => null))?.runtimeMinutes ?? 45;
        runtimes.set(key, rt);
      }
      out.push({ ...rest, runtimeMinutes: rt ?? 45 });
    }
    return out;
  }

  async function createPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!planLimiter.take(clientKey(req))) throw new HttpError(429, "Too many plans; try again in a minute");
    const request = parsePlanRequest(await readJson(req, maxBody), maxShows);
    if (running >= maxConcurrent) throw new HttpError(503, "Busy planning other channels; try again shortly");

    running++;
    // NDJSON stream: one line per Qloo call as it completes, then the plan.
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
    const write = (line: unknown) => {
      if (!res.writableEnded) res.write(JSON.stringify(line) + "\n");
    };
    const client = new TracingClient(opts.qloo, (entry) => write({ type: "trace", entry }));
    let timer: NodeJS.Timeout | undefined;
    try {
      const library = await withRuntimes(request.library);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          client.cancel();
          reject(new Error("Planning took too long"));
        }, planTimeout);
      });
      const plan = await Promise.race([planDay(client, library), timeout]);
      const id = randomUUID();
      plans.set(id, plan);
      write({ type: "plan", plan: planView(id, plan, client.trace) });
    } catch (err) {
      write({ type: "error", message: err instanceof Error ? err.message : "Planning failed" });
    } finally {
      clearTimeout(timer);
      running--;
      res.end();
    }
  }

  async function scorePlan(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (!scoreLimiter.take(clientKey(req))) throw new HttpError(429, "Too many requests");
    const plan = plans.get(id);
    if (!plan) throw new HttpError(404, "Plan not found or expired; plan the channel again");
    const body = (await readJson(req, maxBody)) as { sequence?: unknown } | null;
    const seq = body?.sequence;
    if (!Array.isArray(seq) || !seq.every((x) => typeof x === "string")) throw new HttpError(400, "sequence must be an array of show IDs");
    // Reordering only: the edited day must hold exactly the airings the plan had.
    const key = (xs: string[]) => [...xs].sort().join("\n");
    if (key(seq) !== key(plan.schedule.slots.map((s) => s.showId))) {
      throw new HttpError(400, "sequence must reorder the planned airings, not add or remove them");
    }
    sendJson(res, 200, scoreView(plan, annotate(plan.solverInput, seq)));
  }

  async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
    const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
    const file = resolve(join(publicDir, rel));
    if (file !== publicDir && !file.startsWith(publicDir + sep)) throw new HttpError(404, "Not found");
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, "Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", ...SECURITY_HEADERS });
    res.end(data);
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/api/health") return sendJson(res, 200, { ok: true, synthetic: opts.qloo.synthetic ?? false });
      if (req.method === "GET" && path === "/api/presets") return sendJson(res, 200, PRESETS);
      if (req.method === "POST" && path === "/api/plans") return await createPlan(req, res);
      const score = path.match(/^\/api\/plans\/([0-9a-f-]{36})\/score$/);
      if (req.method === "POST" && score) return await scorePlan(req, res, score[1]!);
      if (path.startsWith("/api/")) throw new HttpError(404, "Not found");
      if (req.method === "GET" || req.method === "HEAD") return await serveStatic(res, path);
      throw new HttpError(405, "Method not allowed");
    } catch (err) {
      if (res.headersSent) return void res.end();
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: err instanceof HttpError ? err.message : "Internal error" });
    }
  });
}
