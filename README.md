# Lead-In

An audience-flow programming agent for FAST channels (Pluto TV, Tubi, Samsung TV Plus, Roku Channel).
Give it a show library and it builds a 24-hour schedule where each show hands its audience to the next.
It also flags weak handoffs and suggests titles to license for dayparts the library serves poorly.
The taste signals come from [Qloo](https://www.qloo.com/): pairwise audience overlap, audience demographics and affinity recommendations.

> **Status:** early build. The Qloo layer currently runs on a **synthetic** stand-in (`src/qloo/fake.ts`)
> until the hackathon API key arrives. Every number it produces is invented and labelled as such.

## How it works

1. **Resolve** each title to a Qloo entity. Ambiguous names come back as `needs_input` with candidates; the tool never guesses.
2. **Audience skew** per show (Qloo `audience_demographics`) → daypart fit. The daypart audience profiles
   in `src/solver/dayparts.ts` are our own interpretation, not Qloo data.
3. **Overlap matrix**, directional (A→B ≠ B→A). It's built from `compare_audiences` (symmetric) or from
   `recommend` affinities (asymmetric). Every edge records which one it came from.
4. **Solve** the day: 48 half-hour units, runtimes from TMDB plus ad load. Shows may repeat within limits, every licensed
   show airs at least once, and the day wraps at midnight. The solver uses beam search, then local search with seeded kicks.
5. **Gaps → licensing:** weak dayparts get title suggestions from Qloo `recommend`, ranked by fit for that daypart.

Every Qloo call is recorded in a redacted trace (`src/qloo/trace.ts`) for the request-to-result walkthrough.

## Run it

Requires Node ≥ 22.19.

```bash
npm install
npm test            # unit tests (solver checked against brute force)
npm run demo        # 24h grid on the synthetic library (add -- --recommend for the recommend matrix)
npm run tmdb:smoke  # live TMDB runtime check; needs TMDB_READ_ACCESS_TOKEN in ../.env
```

## Data and privacy

Only cultural signals (show titles and entity IDs) are sent to Qloo. No personal data is sent.
Qloo results are aggregate affinities, so the app never presents them as facts about an individual viewer.

TV metadata comes from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

MIT, see [LICENSE](LICENSE).
