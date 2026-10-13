// The one Durable Object behind /api/*. It owns everything that must be global: the Qloo throttle and
// quota reserve (inside RestQlooClient), the Qloo cache and saved plans (SQLite, so they survive eviction),
// and rate limits (memory: they reset if the object is evicted, which only ever loosens them briefly).
//
// Note: in Workers the clock only advances at I/O, so the solver's time budget never trips here. Unbudgeted
// solves measured 0.75 s (12 shows) and 1.2–1.4 s (40 shows) in Node, well under the 30 s CPU limit, but
// they do hold this object (and so every visitor) for that long.

import { DurableObject } from "cloudflare:workers";
import { CachingClient } from "../qloo/cache.js";
import { FakeQlooClient } from "../qloo/fake.js";
import { RestQlooClient } from "../qloo/rest.js";
import { registerSecrets } from "../qloo/trace.js";
import { createHandler, type ApiHandler } from "../server/handler.js";
import { TmdbClient } from "../tmdb/client.js";
import { SqlCacheStore } from "./sql-cache.js";
import { SqlPlanStore } from "./sql-plans.js";

/** Set by the Worker from cf-connecting-ip; any client-sent value is overwritten before it gets here. */
export const CLIENT_IP_HEADER = "x-lead-in-client-ip";

export class Coordinator extends DurableObject<Env> {
  private readonly api: ApiHandler;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    registerSecrets([env.QLOO_API_KEY, env.TMDB_READ_ACCESS_TOKEN]);
    const inner = env.QLOO_API_KEY ? new RestQlooClient({ apiKey: env.QLOO_API_KEY }) : new FakeQlooClient();
    const store = inner.synthetic ? undefined : new SqlCacheStore(ctx.storage.sql);
    const qloo = new CachingClient(inner, 5000, undefined, store);
    const tmdb = env.TMDB_READ_ACCESS_TOKEN ? new TmdbClient({ token: env.TMDB_READ_ACCESS_TOKEN }) : null;
    this.api = createHandler({ qloo, tmdb, planStore: new SqlPlanStore(ctx.storage.sql) });
  }

  override async fetch(request: Request): Promise<Response> {
    return this.api(request, request.headers.get(CLIENT_IP_HEADER) ?? "unknown");
  }
}
