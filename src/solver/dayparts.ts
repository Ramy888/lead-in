// Daypart fit: how well a show's aggregate audience skew matches who is typically watching at that hour.
// The daypart audience profiles are OUR INTERPRETATION (industry rule of thumb), not Qloo data; the show
// skews they are compared against come from Qloo's audience_demographics.

import type { AgeBand, Demographics } from "../qloo/types.js";
import type { Slot } from "./solve.js";

export interface Daypart {
  name: string;
  /** Clock hours, start inclusive, end exclusive; may wrap past midnight (e.g. 23 → 2). */
  startHour: number;
  endHour: number;
  profile: Demographics;
}

export const DAYPARTS: Daypart[] = [
  { name: "Morning", startHour: 6, endHour: 9, profile: { age: { "55_and_older": 0.6, "45_to_54": 0.2 }, gender: { female: 0.3 } } },
  { name: "Daytime", startHour: 9, endHour: 16, profile: { age: { "55_and_older": 0.8, "24_and_younger": -0.3 }, gender: { female: 0.5 } } },
  { name: "Early fringe", startHour: 16, endHour: 19, profile: { age: { "35_to_44": 0.4, "45_to_54": 0.4, "55_and_older": 0.3 }, gender: {} } },
  { name: "Prime", startHour: 19, endHour: 23, profile: { age: { "25_to_29": 0.3, "30_to_34": 0.4, "35_to_44": 0.5, "45_to_54": 0.4 }, gender: {} } },
  { name: "Late night", startHour: 23, endHour: 2, profile: { age: { "24_and_younger": 0.5, "25_to_29": 0.4, "55_and_older": -0.3 }, gender: { male: 0.3 } } },
  { name: "Overnight", startHour: 2, endHour: 6, profile: { age: { "55_and_older": 0.5, "45_to_54": 0.3 }, gender: { male: 0.2 } } },
];

const AGE_BANDS: AgeBand[] = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];

function vector(d: Demographics): number[] {
  return [...AGE_BANDS.map((b) => d.age[b] ?? 0), d.gender.female ?? 0, d.gender.male ?? 0];
}

/** Cosine similarity of skews mapped to 0..1; 0.5 is neutral (also used when demographics are missing). */
export function demographicFit(show: Demographics | undefined, profile: Demographics): number {
  if (!show) return 0.5;
  const a = vector(show), b = vector(profile);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  if (!na || !nb) return 0.5;
  return Math.min(1, Math.max(0, 0.5 + 0.5 * (dot / Math.sqrt(na * nb))));
}

export interface Clock {
  /** Hour the broadcast day starts at (unit 0). */
  dayStartHour: number;
  unitMinutes: number;
}

export const DEFAULT_CLOCK: Clock = { dayStartHour: 6, unitMinutes: 30 };

export function unitToHour(unit: number, clock: Clock = DEFAULT_CLOCK): number {
  return (clock.dayStartHour + (unit * clock.unitMinutes) / 60) % 24;
}

export function formatTime(unit: number, clock: Clock = DEFAULT_CLOCK): string {
  const h = unitToHour(unit, clock);
  return `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
}

export function daypartAt(hour: number, dayparts: Daypart[] = DAYPARTS): Daypart {
  const hit = dayparts.find((d) =>
    d.startHour < d.endHour ? hour >= d.startHour && hour < d.endHour : hour >= d.startHour || hour < d.endHour,
  );
  if (!hit) throw new Error(`No daypart covers hour ${hour}`);
  return hit;
}

/** Builds the solver's fit function from per-show demographics. */
export function fitFunction(demographics: Map<string, Demographics | undefined>, clock: Clock = DEFAULT_CLOCK, dayparts = DAYPARTS) {
  const cache = new Map<string, number>();
  return (showId: string, unit: number): number => {
    const part = daypartAt(unitToHour(unit, clock), dayparts);
    const key = `${showId}|${part.name}`;
    let fit = cache.get(key);
    if (fit === undefined) cache.set(key, (fit = demographicFit(demographics.get(showId), part.profile)));
    return fit;
  };
}

export interface DaypartGap {
  daypart: string;
  /** Airtime-weighted mean fit of what currently airs there. */
  meanFit: number;
}

/** Dayparts the library serves poorly: candidates for the "license these titles" panel. */
export function weakDayparts(slots: Slot[], threshold = 0.5, clock: Clock = DEFAULT_CLOCK, dayparts = DAYPARTS): DaypartGap[] {
  const sums = new Map<string, { fit: number; units: number }>();
  for (const slot of slots) {
    const name = daypartAt(unitToHour(slot.startUnit, clock), dayparts).name;
    const s = sums.get(name) ?? { fit: 0, units: 0 };
    sums.set(name, { fit: s.fit + slot.fit * slot.units, units: s.units + slot.units });
  }
  return [...sums]
    .map(([daypart, s]) => ({ daypart, meanFit: Math.round((s.fit / s.units) * 1000) / 1000 }))
    .filter((g) => g.meanFit < threshold)
    .sort((a, b) => a.meanFit - b.meanFit);
}
