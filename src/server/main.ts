// Production entry point. QLOO_API_KEY selects real Qloo; without it the synthetic stand-in runs and the
// UI says so.

import { fileURLToPath } from "node:url";
import { NemotronClient } from "../agent/llm.js";
import { qlooFromEnv } from "../qloo/from-env.js";
import { TmdbClient } from "../tmdb/client.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const tmdbToken = process.env.TMDB_READ_ACCESS_TOKEN, tmdbKey = process.env.TMDB_API_KEY;
const tmdb = tmdbToken || tmdbKey ? new TmdbClient({ token: tmdbToken, apiKey: tmdbKey }) : null;

const qloo = qlooFromEnv();
const agent = process.env.NEBIUS_API_KEY ? { llm: new NemotronClient({ apiKey: process.env.NEBIUS_API_KEY }) } : undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    qloo.flush();
    process.exit(0);
  });
}

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
createApp({ qloo, tmdb, agent, publicDir, trustProxy: process.env.TRUST_PROXY === "1" }).listen(port, () => {
  console.log(`Lead-In listening on :${port} (${qloo.synthetic ? "synthetic Qloo data" : "Qloo"}, TMDB ${tmdb ? "on" : "off"}, agent ${agent ? "on" : "off"})`);
});
