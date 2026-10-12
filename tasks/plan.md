# Plan: Lead-In, key-independent slice

Goal: everything Lead-In needs that does not depend on a live Qloo key, shaped so the day-1 gate
result is a config swap (which matrix builder, which client), not a rewrite.

## Decisions

- Repo lives in `lead-in/` so the parent folder's private notes (`CLAUDE.md`, `research/`) never get committed.
- GitHub repo is **private** until submission, then flipped to public (commit dates survive).
- Node ≥ 22.19, TypeScript compiled with `tsc`, tests with `vitest`. No runtime deps for the core.
- A show may air more than once a day (FAST channels repeat). The day is 48 half-hour units;
  each show occupies `ceil((runtime + ad load) / 30)` units.
- Overlap is **directional** (A→B ≠ B→A). Every edge carries provenance: `compare` | `recommend` | `synthetic`.
- The LLM/agent loop is deferred.

## Dependency graph

```
types (Show, Envelope, Edge) ─┬─ qloo/client (interface, fake, trace)
                              ├─ matrix (compare + recommend builders) ── needs qloo/client
                              ├─ tmdb (search, runtime fallback)
                              └─ solver (needs matrix + Show runtimes + daypart fit)
                                        └─ cli demo (wires fake client + tmdb fixtures + solver)
```

## Tasks

1. **Scaffold.** package.json, tsconfig, vitest, MIT LICENSE, .nvmrc, .gitignore, README stub.
   Accept: `npm test` and `npm run build` pass on an empty suite. Verify: run both.
2. **Qloo client contract + fake + trace.** `QlooClient` with the nine tool names, envelope
   `status: ok|empty|needs_input|partial|degraded|error`. `FakeQlooClient` on synthetic data, labelled synthetic.
   `TracingClient` wrapper that records tool, params, status, ms and result count, and redacts key-like strings.
   Accept: a test proves a 32+ char token in params never reaches the trace.
3. **Overlap matrix.** `fromCompare` (symmetric score fills both directions) and `fromRecommend`
   (A→B = B's affinity in A's recs, 0 if absent). Edge provenance kept. `needs_input`/`error` surface, not swallowed.
   Accept: tests for asymmetry, missing pairs, provenance.
4. **TMDB import.** Search tv, details, runtime = show-level `episode_run_time` else median of season 1 episode runtimes.
   Accept: fixture test for the Columbo case (show-level empty → 75/76 from season). Live smoke script verifies it for real.
5. **Solver.** Daypart fit from demographic skew; directional handoff score; greedy multi-start + local search
   (swap, same-length replace); max airings per show and max consecutive stack; day wraps (last → first).
   Outputs: slots with times, per-handoff score, weak-handoff flags, weak dayparts as license gaps.
   Accept (TDD, fail first): 3-show cycle instance returns the known optimal cycle; on small random instances
   the result is ≥ 95% of brute force; all constraints hold; units sum to 48.
6. **CLI demo.** `npm run demo` prints a 24h grid for the synthetic classic-crime library, weak handoffs, gaps and the trace.

Checkpoint after 3 (contracts settled), after 5 (solver proven), after 6 (end-to-end on fake data).

## Out of scope / unverified until the key arrives

Every Qloo-dependent claim: whether compare_audiences returns a pairwise number, whether demographics exist
for tv_show, real affinity values. Run `../scripts/day1_tests.sh` before writing the real adapter.
