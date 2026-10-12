// Production entry point. QLOO_API_KEY selects real Qloo once the adapter exists; until then the
// synthetic stand-in runs and the UI says so.

import { fileURLToPath } from "node:url";
import { CachingClient } from "../qloo/cache.js";
import { FakeQlooClient } from "../qloo/fake.js";
import { TmdbClient } from "../tmdb/client.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const tmdbToken = process.env.TMDB_READ_ACCESS_TOKEN, tmdbKey = process.env.TMDB_API_KEY;
const tmdb = tmdbToken || tmdbKey ? new TmdbClient({ token: tmdbToken, apiKey: tmdbKey }) : null;

if (process.env.QLOO_API_KEY) console.warn("QLOO_API_KEY is set but the real Qloo adapter isn't built yet; using synthetic data.");
const qloo = new CachingClient(new FakeQlooClient());

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
createApp({ qloo, tmdb, publicDir, trustProxy: process.env.TRUST_PROXY === "1" }).listen(port, () => {
  console.log(`Lead-In listening on :${port} (${qloo.synthetic ? "synthetic Qloo data" : "Qloo"}, TMDB ${tmdb ? "on" : "off"})`);
});
