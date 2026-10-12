// 24h slot solver. The day is a loop of `dayUnits` (48 half-hours); each airing occupies its show's units.
// A day scores the sum of every handoff (directional overlap from one show to the next, wrapping past the
// end of the day) plus each show's fit for the slot it airs in. Shows may repeat, within limits.
// Beam search builds candidates; first-improvement local search with seeded kicks polishes them.

export interface SolverShow {
  id: string;
  /** Half-hour units one airing occupies (runtime plus ad load). */
  units: number;
}

export interface SolverInput {
  shows: SolverShow[];
  dayUnits: number;
  /** Directional overlap, 0..1: how much of `from`'s audience stays for `to`. */
  handoff: (from: string, to: string) => number;
  /** Daypart fit of a show starting at `unit`, 0..1. */
  fit: (showId: string, unit: number) => number;
  maxAirings: number;
  /** Fewest airings per show: a channel has to air what it licenses. Default 0. */
  minAirings?: number;
  /** Most consecutive airings of one show (a "stack" of episodes). */
  maxStack: number;
  /** Handoff score credited when a show is followed by another episode of itself. */
  stackScore: number;
  handoffWeight?: number;
  /** Weight of fit per unit of airtime. */
  fitWeight?: number;
  weakThreshold?: number;
}

export interface Slot {
  showId: string;
  startUnit: number;
  units: number;
  fit: number;
  /** Score of the handoff from this slot to the next (the last slot hands off to the first). */
  handoffScore: number;
  weakHandoff: boolean;
}

export interface SolveResult {
  slots: Slot[];
  score: number;
}

const DEFAULTS = { handoffWeight: 1, fitWeight: 0.25, weakThreshold: 0.35 };

function pairScore(inp: SolverInput, from: string, to: string): number {
  return from === to ? inp.stackScore : inp.handoff(from, to);
}

/** True when some run of more than maxStack consecutive airings (cyclic) is the same show. */
function breaksStack(seq: string[], maxStack: number): boolean {
  const n = seq.length;
  if (n <= maxStack) return false;
  for (let i = 0; i < n; i++) {
    let run = 1;
    while (run <= maxStack && seq[(i + run) % n] === seq[i]) run++;
    if (run > maxStack) return true;
  }
  return false;
}

/** Score of a full day, or null if it breaks a constraint or doesn't fill the day exactly. */
export function scoreSequence(inp: SolverInput, seq: string[]): number | null {
  const { handoffWeight, fitWeight } = { ...DEFAULTS, ...inp };
  const units = new Map(inp.shows.map((s) => [s.id, s.units]));
  const airings = new Map<string, number>();
  let unit = 0, score = 0;
  for (let i = 0; i < seq.length; i++) {
    const id = seq[i]!;
    const u = units.get(id);
    if (u === undefined) return null;
    const count = (airings.get(id) ?? 0) + 1;
    if (count > inp.maxAirings) return null;
    airings.set(id, count);
    score += fitWeight * u * inp.fit(id, unit) + handoffWeight * pairScore(inp, id, seq[(i + 1) % seq.length]!);
    unit += u;
  }
  if (unit !== inp.dayUnits || breaksStack(seq, inp.maxStack)) return null;
  const min = inp.minAirings ?? 0;
  if (min && inp.shows.some((s) => (airings.get(s.id) ?? 0) < min)) return null;
  return score;
}

/** Can `remaining` units be filled exactly with the airings left, while still airing every show its
 *  minimum? (Owed airtime first, then bounded-knapsack reachability for the rest.) */
function canFill(inp: SolverInput, remaining: number, used: Map<string, number>): boolean {
  const min = inp.minAirings ?? 0;
  const owed = inp.shows.reduce((t, s) => t + Math.max(0, min - (used.get(s.id) ?? 0)) * s.units, 0);
  if (owed > remaining) return false;
  let reach = new Set([0]);
  for (const show of inp.shows) {
    const left = inp.maxAirings - (used.get(show.id) ?? 0);
    for (let k = 0; k < left; k++) {
      const next = new Set(reach);
      for (const r of reach) if (r + show.units <= remaining) next.add(r + show.units);
      if (next.size === reach.size) break;
      reach = next;
    }
  }
  return reach.has(remaining);
}

interface Partial {
  seq: string[];
  unit: number;
  stack: number;
  used: Map<string, number>;
  score: number;
}

/** Beam search over partial days: keeps the `width` best prefixes at each step, dropping any prefix whose
 *  remaining airtime can no longer be filled. Returns complete, valid days, best first. */
function beam(inp: SolverInput, width: number): string[][] {
  const { handoffWeight, fitWeight } = { ...DEFAULTS, ...inp };
  const fillMemo = new Map<string, boolean>();
  const fillable = (remaining: number, used: Map<string, number>) => {
    const key = remaining + "|" + inp.shows.map((s) => used.get(s.id) ?? 0).join(",");
    let ok = fillMemo.get(key);
    if (ok === undefined) fillMemo.set(key, (ok = canFill(inp, remaining, used)));
    return ok;
  };

  let frontier: Partial[] = [{ seq: [], unit: 0, stack: 0, used: new Map(), score: 0 }];
  const done: Array<{ seq: string[]; score: number }> = [];
  while (frontier.length) {
    const next: Partial[] = [];
    for (const p of frontier) {
      const prev = p.seq[p.seq.length - 1];
      for (const show of inp.shows) {
        const count = p.used.get(show.id) ?? 0;
        if (count >= inp.maxAirings || p.unit + show.units > inp.dayUnits) continue;
        const stack = show.id === prev ? p.stack + 1 : 1;
        if (stack > inp.maxStack) continue;
        const used = new Map(p.used).set(show.id, count + 1);
        const unit = p.unit + show.units;
        if (!fillable(inp.dayUnits - unit, used)) continue;
        const seq = [...p.seq, show.id];
        const score = p.score + fitWeight * show.units * inp.fit(show.id, p.unit)
          + (prev === undefined ? 0 : handoffWeight * pairScore(inp, prev, show.id));
        if (unit === inp.dayUnits) {
          const full = scoreSequence(inp, seq);
          if (full !== null) done.push({ seq, score: full });
        } else {
          next.push({ seq, unit, stack, used, score });
        }
      }
    }
    next.sort((x, y) => y.score - x.score);
    const seen = new Set<string>();
    frontier = [];
    for (const p of next) {
      // Prefixes that end the same way with the same airings left are interchangeable for the future.
      const key = `${p.unit}|${p.seq[0]}|${p.seq[p.seq.length - 1]}|${p.stack}|${[...p.used].sort().join()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frontier.push(p);
      if (frontier.length >= width) break;
    }
  }
  return done.sort((x, y) => y.score - x.score).map((d) => d.seq);
}

/** Every day reachable from `seq` by one move: swap two airings, relocate one, or rewrite a window of
 *  one or two adjacent airings as any one or two shows filling the same airtime (replace, split, merge). */
function* neighbours(inp: SolverInput, seq: string[]): Generator<string[]> {
  const units = new Map(inp.shows.map((s) => [s.id, s.units]));
  const n = seq.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (seq[i] === seq[j]) continue;
      const s = [...seq];
      [s[i], s[j]] = [s[j]!, s[i]!];
      yield s;
    }
  }
  for (let i = 0; i < n; i++) {
    const rest = seq.filter((_, k) => k !== i);
    for (let j = 0; j < n; j++) if (j !== i) yield [...rest.slice(0, j), seq[i]!, ...rest.slice(j)];
  }
  for (let w = 1; w <= 2; w++) {
    for (let i = 0; i + w <= n; i++) {
      const window = seq.slice(i, i + w);
      const total = window.reduce((t, id) => t + units.get(id)!, 0);
      const before = seq.slice(0, i), after = seq.slice(i + w);
      for (const a of inp.shows) {
        if (a.units === total && (w > 1 || a.id !== window[0])) yield [...before, a.id, ...after];
        for (const b of inp.shows) {
          if (a.units + b.units !== total || (w === 2 && a.id === window[0] && b.id === window[1])) continue;
          yield [...before, a.id, b.id, ...after];
        }
      }
    }
  }
}

function localSearch(inp: SolverInput, start: string[], maxPasses = 200): { seq: string[]; score: number } {
  let seq = start, score = scoreSequence(inp, start)!;
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (const cand of neighbours(inp, seq)) {
      const s = scoreSequence(inp, cand);
      if (s !== null && s > score + 1e-12) {
        [seq, score, improved] = [cand, s, true];
        break;
      }
    }
    if (!improved) break;
  }
  return { seq, score };
}

/** Random restart kick: swap two airings, then rotate the day so a different airing opens it. */
function kick(seq: string[], rand: () => number): string[] {
  const s = [...seq];
  const i = Math.floor(rand() * s.length), j = Math.floor(rand() * s.length);
  [s[i], s[j]] = [s[j]!, s[i]!];
  const r = Math.floor(rand() * s.length);
  return [...s.slice(r), ...s.slice(0, r)];
}

export interface SolveOptions {
  /** Partial days kept per beam step. */
  beamWidth?: number;
  /** Best beam results polished by local search. */
  starts?: number;
  /** Iterated-local-search kicks after polishing. Seeded, so results are reproducible. */
  kicks?: number;
  seed?: number;
}

export function solve(inp: SolverInput, { beamWidth = 64, starts = 3, kicks = 30, seed = 1 }: SolveOptions = {}): SolveResult {
  const { weakThreshold } = { ...DEFAULTS, ...inp };
  const seeds = beam(inp, beamWidth).slice(0, starts);
  if (!seeds.length) throw new Error("Library cannot fill the day: add shows or raise maxAirings/maxStack.");

  let best = seeds.map((seq) => localSearch(inp, seq)).sort((a, b) => b.score - a.score)[0]!;
  let state = seed >>> 0;
  const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let k = 0; k < kicks; k++) {
    const start = kick(best.seq, rand);
    if (scoreSequence(inp, start) === null) continue;
    const cand = localSearch(inp, start);
    if (cand.score > best.score + 1e-12) best = cand;
  }
  const units = new Map(inp.shows.map((s) => [s.id, s.units]));
  let unit = 0;
  const slots = best.seq.map((showId, i) => {
    const next = best.seq[(i + 1) % best.seq.length]!;
    const handoffScore = pairScore(inp, showId, next);
    const slot: Slot = {
      showId,
      startUnit: unit,
      units: units.get(showId)!,
      fit: inp.fit(showId, unit),
      handoffScore,
      weakHandoff: showId !== next && handoffScore < weakThreshold,
    };
    unit += slot.units;
    return slot;
  });
  return { slots, score: best.score };
}
