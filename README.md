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

## The agent (Claude)

The planner gives you a good day; the agent works on what you actually want. Type a goal ("fix the worst
handoff; I can license one title") and Claude Opus 5.5 runs a tool loop (`src/agent/agent.ts`):

| Tool | What it does |
|---|---|
| `find_bridge(from, to)` | Qloo recommend with **both** shows of a weak handoff as signals: titles whose audience overlaps each side |
| `find_titles_for_daypart(daypart)` | Qloo titles that share the library's audience, ranked by fit for that daypart |
| `what_if(add, remove)` | Re-plans the full 24h day with titles added or dropped and reports the flow change |
| `get_plan(id?)` | Reads the current plan or a what-if |
| `finish(...)` | Recommendation, with Qloo-sourced facts and Lead-In's own reading kept in separate lists |

Example (live, Classic TV Mix): in one turn Claude called `find_bridge(M*A*S*H → Baywatch)` and `what_if(−Baywatch)`;
Qloo suggested The A-Team, `what_if(+The A-Team)` removed the only weak handoff and raised flow 0.824 → 0.847, while
dropping Baywatch only moved the problem (0.806, a new weak handoff). It adopted The A-Team. 3 model calls, ~$0.04.

Guardrails: at most 8 steps, 3 what-ifs and 2 added titles each, a token budget, a 2-minute timeout that also
stops Qloo calls; per-visitor rate limit; one run at a time; and a persisted daily-run cap and total spend cap
(`AGENT_MAX_RUNS_PER_DAY`, `AGENT_MAX_USD`). Requests use adaptive thinking at medium effort, prompt caching, and
server-side refusal fallbacks. The model sees only show titles, Qloo IDs and scores; the brief is a request, not instructions.

## Does it need Qloo? (benchmark)

`npm run bench` builds each demo library's day four ways and scores them all on the same scale:
Lead-In (Qloo), **the same Claude model scheduling from its own knowledge** with the same goal and rules, the
library in listed order, and 50 shuffled orders. Results (`bench/results.json`, Oct 13 2026, 3 Claude attempts each):

| Library | Lead-In (Qloo) | Claude alone | Listed order | Shuffled |
|---|---|---|---|---|
| Classic TV Mix (9 shows) | **0.824** flow, 1 weak handoff | 0.660, 3 weak | 0.669, 9 weak | 0.456, 10.8 weak |
| Classic Crime & Action (12) | **0.893**, 0 weak | 0.769, 0.3 weak | 0.812, 1 weak | 0.614, 2.4 weak |
| Cozy Mysteries (4) | **0.942** | 0.897 | 0.912 | 0.894 |

Claude alone produced complete, rule-respecting days but couldn't tell which shows share an audience the way
Qloo measures it. Caveat: the scale itself comes from Qloo's audience overlap and Lead-In's daypart model, so this
shows what Qloo's data adds to scheduling, not a measurement of real viewers. The "vs AI alone" tab runs the same
comparison on any planned day.

Every Qloo call is recorded in a redacted trace (`src/qloo/trace.ts`) for the request-to-result walkthrough.

## The app

`npm run dev` serves the API and UI at http://localhost:8080. Pick a library, plan the channel and watch the Qloo calls
stream in. The day appears as a half-circle dial from 06:00 to 06:00: an outer band of dayparts (weak ones outlined),
a ring of shows, and a mark at every handoff (red where the audience mostly leaves). **+ Add a show** searches TMDB (skeleton while it loads) so a show joins with its real episode length and year;
a title TMDB doesn't know can still be added as typed after you confirm a length. Tap a show on the dial to see its handoffs
and move it earlier or later (every handoff is re-scored); tap a daypart for titles to license. The middle of the dial
holds the audience-flow score, the weak-handoff and daypart-gap counts with **Fix** buttons, and **Run the agent**,
which opens a dialog for your goal. The **Insights** drawer (app bar) has the licensing list, "vs AI alone", the
overlap heatmap and the full Qloo call trace; the app bar also switches light and dark mode.

| Route | What it does |
|---|---|
| `GET /api/presets` | Demo libraries |
| `POST /api/plans` | `{library:[{name, runtimeMinutes?, year?, qlooId?}]}` → NDJSON stream: one `trace` line per Qloo call, then the `plan` |
| `GET /api/tmdb/search?q=` | TV shows on TMDB matching a typed title (top 6, cached 1 h), for the add-show dialog |
| `GET /api/tmdb/shows/:tmdbId` | The picked show's episode length and first-air year (404 when TMDB has no length) |
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
npm run agent:smoke # one live agent run (Claude + Qloo, a few cents); PRESET=1 for Classic TV Mix
npm run bench       # Lead-In vs Claude alone vs listed vs shuffled on every preset (~$0.15)
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
npx wrangler secret put ANTHROPIC_API_KEY          # enables the agent and the AI-alone comparison
npm run cf:deploy                                # typecheck + tests + wrangler deploy
```

For `npm run cf:dev`, put the same keys in `.dev.vars` (gitignored). A `Dockerfile` is kept for
container hosts (mount a volume at `/data` for the cache).

Environment: `QLOO_API_KEY` (server only, never sent to the browser), optional `TMDB_READ_ACCESS_TOKEN` and
`ANTHROPIC_API_KEY` (the agent);
for Node also `QLOO_CACHE_FILE`, `PORT`, `TRUST_PROXY=1` behind a proxy.

## Data and privacy

Only cultural signals (show titles and entity IDs) are sent to Qloo. No personal data is sent.
Qloo results are aggregate affinities, so the app never presents them as facts about an individual viewer.

TV metadata comes from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

MIT, see [LICENSE](LICENSE).
