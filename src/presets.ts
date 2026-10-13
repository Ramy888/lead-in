// Demo libraries. Runtimes are TMDB episode runtimes (Columbo, Murder, She Wrote and Baywatch verified live).
// Years pick the original over a same-named remake (Matlock, Perry Mason, Magnum, P.I., Knight Rider).

import type { LibraryItem } from "./pipeline.js";

export interface Preset {
  id: string;
  name: string;
  description: string;
  library: LibraryItem[];
}

export const PRESETS: Preset[] = [
  {
    id: "classic-crime",
    name: "Classic Crime & Action",
    description: "A 12-title library of 70s–90s detectives, lawyers and action heroes. Qloo sees two close audiences: mysteries and action.",
    library: [
      { name: "Columbo", year: 1971, runtimeMinutes: 76 },
      { name: "Murder, She Wrote", year: 1984, runtimeMinutes: 45 },
      { name: "Matlock", year: 1986, runtimeMinutes: 48 },
      { name: "Perry Mason", year: 1957, runtimeMinutes: 51 },
      { name: "Diagnosis: Murder", year: 1993, runtimeMinutes: 45 },
      { name: "Quincy, M.E.", year: 1976, runtimeMinutes: 50 },
      { name: "The Rockford Files", year: 1974, runtimeMinutes: 50 },
      { name: "Magnum, P.I.", year: 1980, runtimeMinutes: 48 },
      { name: "Knight Rider", year: 1982, runtimeMinutes: 48 },
      { name: "The A-Team", year: 1983, runtimeMinutes: 48 },
      { name: "Walker, Texas Ranger", year: 1993, runtimeMinutes: 45 },
      { name: "Baywatch", year: 1989, runtimeMinutes: 42 },
    ],
  },
  {
    id: "classic-mix",
    name: "Classic TV Mix",
    description: "Crime, sitcoms and action on one channel. Some handoffs lose the audience; ask the agent to fix them.",
    library: [
      { name: "Columbo", year: 1971, runtimeMinutes: 76 },
      { name: "Murder, She Wrote", year: 1984, runtimeMinutes: 45 },
      { name: "Matlock", year: 1986, runtimeMinutes: 48 },
      { name: "The Golden Girls", year: 1985, runtimeMinutes: 22 },
      { name: "Cheers", year: 1982, runtimeMinutes: 25 },
      { name: "Frasier", year: 1993, runtimeMinutes: 22 },
      { name: "M*A*S*H", year: 1972, runtimeMinutes: 25 },
      { name: "Knight Rider", year: 1982, runtimeMinutes: 48 },
      { name: "Baywatch", year: 1989, runtimeMinutes: 42 },
    ],
  },
  {
    id: "cozy-mysteries",
    name: "Cozy Mysteries",
    description: "A small daytime-friendly library. Too thin for late night, so watch the licensing panel.",
    library: [
      { name: "Murder, She Wrote", year: 1984, runtimeMinutes: 45 },
      { name: "Diagnosis: Murder", year: 1993, runtimeMinutes: 45 },
      { name: "Matlock", year: 1986, runtimeMinutes: 48 },
      { name: "Columbo", year: 1971, runtimeMinutes: 76 },
      { name: "Law", runtimeMinutes: 45 },
    ],
  },
];
