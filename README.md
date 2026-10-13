# Lead-In

**Live demo:** https://lead-in.ramy-comm.workers.dev (free, no login)

An audience-flow programming agent for FAST channels (Pluto TV, Tubi, Samsung TV Plus, Roku Channel).
Give it a show library and it builds a 24-hour schedule where each show hands its audience to the next.
It also flags weak handoffs and suggests titles to license for dayparts the library serves poorly.
The taste signals come from [Qloo](https://www.qloo.com/): show-to-show audience affinity, audience demographics and recommendations.

> **Status:** working build on live Qloo data (`src/qloo/rest.ts`). Without `QLOO_API_KEY` it falls back to a
> **synthetic** stand-in (`src/qloo/fake.ts`) whose numbers are invented, and the UI says so.

## How it works

1. **Resolve** each title to a Qloo entity (`/search`). Only an exact title match (ignoring case and punctuation) is
   accepted; a premiere year picks between same-named shows (Matlock 1986 vs 2024). Anything else comes back as
   `needs_input` with candidates, and the picked candidate's ID is sent back. The tool never guesses.
2. **Audience skew** per show (Qloo `audience_demographics`) → daypart fit. The daypart audience profiles
   in `src/solver/dayparts.ts` are our own interpretation, not Qloo data.
3. **Overlap matrix**, directional (A→B ≠ B→A): one `/v2/insights` call per show, with that show as the signal and
   the results restricted to the library (`filter.results.entities`), so N shows cost N calls. Qloo's affinities sit
   in a narrow band (≈0.76 unrelated … 0.975 same niche), so Lead-In maps 0.86 → 0 and 0.975 → 1 as its handoff score
   (our interpretation; the raw affinity is kept and shown). Qloo's `compare` endpoint was tested on day 1: it returns
   shared content tags, not an audience number, so it isn't used for the matrix.
4. **Solve** the day: 48 half-hour units, runtimes from TMDB plus ad load. Shows may repeat within limits, every licensed
   show airs at least once, and the day wraps at midnight. The solver uses beam search, then local search with seeded kicks.
5. **Gaps → licensing:** weak dayparts get title suggestions from Qloo `recommend`, ranked by fit for that daypart.

## The agent (NVIDIA Nemotron on Nebius Token Factory)

The planner gives you a good day; the agent works on what you actually want. Type a goal ("fix the worst
handoff; I can license one title") and Nemotron 3 Ultra runs a tool loop (`src/agent/agent.ts`):

| Tool | What it does |
|---|---|
| `find_bridge(from, to)` | Qloo recommend with **both** shows of a weak handoff as signals: titles whose audience overlaps each side |
| `find_titles_for_daypart(daypart)` | Qloo titles that share the library's audience, ranked by fit for that daypart |
| `what_if(add, remove)` | Re-plans the full 24h day with titles added or dropped and reports the flow change |
| `get_plan(id?)` | Reads the current plan or a what-if |
| `finish(...)` | Recommendation, with Qloo-sourced facts and Lead-In's own reading kept in separate lists |

Example (live, Classic TV Mix): the agent called `find_bridge(M*A*S*H → Baywatch)`, Qloo suggested The A-Team,
`what_if(+The A-Team)` removed the only weak handoff and raised flow 0.824 → 0.847, and the agent adopted it.
3 model calls, ~7k tokens, about $0.01. One click loads the new day into the grid.

Guardrails: at most 8 steps, 3 what-ifs and 2 added titles each, a token budget, a 2-minute timeout that
also stops Qloo calls; per-visitor rate limit; one run at a time; and a persisted daily-run cap and total
Nemotron spend cap (`AGENT_MAX_RUNS_PER_DAY`, `AGENT_MAX_USD`). Ultra falls back to Nemotron 3 Super on errors.
The model sees only show titles, Qloo IDs and scores; the brief is treated as a request, not instructions.

Every Qloo call is recorded in a redacted trace (`src/qloo/trace.ts`) for the request-to-result walkthrough.

## The app

`npm run dev` serves the API and UI at http://localhost:8080. Pick a library, plan the channel and watch the Qloo calls
stream in. Then drag shows (or use ↑ ↓) to try your own order: every handoff is re-scored, and weak ones turn red.
The side panel has weak dayparts with titles to license, the overlap heatmap, and the full Qloo call trace.

| Route | What it does |
|---|---|
| `GET /api/presets` | Demo libraries |
| `POST /api/plans` | `{library:[{name, runtimeMinutes?, year?, qlooId?}]}` → NDJSON stream: one `trace` line per Qloo call, then the `plan` |
| `POST /api/plans/:id/score` | `{sequence:[showId…]}` (a reorder of the plan) → re-scored slots and any rule violations |
| `GET /api/health` | Liveness, plus whether data is synthetic |

The API is public and unauthenticated so judges can use it directly. To make that safe, request bodies are capped at
16 KB and libraries at 40 shows. Each client gets a planning rate limit, at most 3 plans run at once, and each run is
time-limited (a timed-out run stops calling Qloo).

**Qloo quota.** The hackathon key allows 5 requests/second and 10,000/month. All calls share one throttle (4/s), 429s
and 5xx are retried a bounded number of times (honouring `Retry-After`), and new calls stop when the month's remainder
falls to a 500-call reserve. Answers are cached for 7 days, affinities per pair (adding a show costs only its new
pairs), and the cache is written to `QLOO_CACHE_FILE` (default `data/qloo-cache.json`) so restarts spend nothing.
An uncached 12-show plan is about 50 calls.
Missing runtimes are looked up on TMDB when `TMDB_READ_ACCESS_TOKEN` is set.

## Run it

Requires Node ≥ 22.19.

```bash
npm install
npm test            # unit tests (solver checked against brute force)
npm run demo        # 24h grid for the crime preset; live Qloo if QLOO_API_KEY is in ../.env, synthetic otherwise
npm run tmdb:smoke  # live TMDB runtime check; needs TMDB_READ_ACCESS_TOKEN in ../.env
npm run agent:smoke # one live agent run (Nemotron + Qloo, a cent or two); PRESET=1 for Classic TV Mix
npm run dev         # API + UI on :8080 (Node)
npm run cf:dev      # the same app on the Cloudflare runtime (needs .dev.vars, below)
```

## Deploy (Cloudflare Workers)

The live demo runs on Cloudflare: static assets serve the UI, and `/api/*` goes to one Durable Object
(`src/worker/coordinator.ts`). One instance is deliberate: the Qloo key's limits are global, so the
throttle, the quota reserve, the Qloo cache and saved plans live in one place. The cache and plans are
in the object's SQLite, so they survive eviction and redeploys. Rate limits key on `cf-connecting-ip`.

```bash
npx wrangler login
npx wrangler secret put QLOO_API_KEY            # prompts for the value
npx wrangler secret put TMDB_READ_ACCESS_TOKEN
npx wrangler secret put NEBIUS_API_KEY             # enables the agent
npm run cf:deploy                                # typecheck + tests + wrangler deploy
```

For `npm run cf:dev`, put the same keys in `.dev.vars` (gitignored). A `Dockerfile` is kept for
container hosts (mount a volume at `/data` for the cache).

Environment: `QLOO_API_KEY` (server only, never sent to the browser), optional `TMDB_READ_ACCESS_TOKEN` and
`NEBIUS_API_KEY` (the agent);
for Node also `QLOO_CACHE_FILE`, `PORT`, `TRUST_PROXY=1` behind a proxy.

## Data and privacy

Only cultural signals (show titles and entity IDs) are sent to Qloo. No personal data is sent.
Qloo results are aggregate affinities, so the app never presents them as facts about an individual viewer.

TV metadata comes from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

MIT, see [LICENSE](LICENSE).
