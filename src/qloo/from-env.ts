// Picks the Qloo client from the environment: real Qloo when QLOO_API_KEY is set, the synthetic stand-in
// otherwise (the UI labels which one answered). Both sit behind the cache. Node only (file store).

import { CachingClient } from "./cache.js";
import { FileCacheStore } from "./cache-file.js";
import { FakeQlooClient } from "./fake.js";
import { RestQlooClient } from "./rest.js";

export function qlooFromEnv(env: NodeJS.ProcessEnv = process.env): CachingClient {
  const inner = env.QLOO_API_KEY ? new RestQlooClient({ apiKey: env.QLOO_API_KEY }) : new FakeQlooClient();
  // Only real answers are worth keeping across restarts; QLOO_CACHE_FILE="" turns persistence off.
  const path = inner.synthetic ? undefined : (env.QLOO_CACHE_FILE ?? "data/qloo-cache.json") || undefined;
  return new CachingClient(inner, 5000, undefined, path ? new FileCacheStore(path) : undefined);
}
