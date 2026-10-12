// Demo libraries. Runtimes are TMDB episode runtimes (Columbo, Murder, She Wrote and Baywatch verified live).

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
    description: "A 12-title library of 70s–90s detectives, lawyers and action heroes, plus one show that doesn't fit.",
    library: [
      { name: "Columbo", runtimeMinutes: 76 },
      { name: "Murder, She Wrote", runtimeMinutes: 45 },
      { name: "Matlock", runtimeMinutes: 48 },
      { name: "Perry Mason", runtimeMinutes: 51 },
      { name: "Diagnosis: Murder", runtimeMinutes: 45 },
      { name: "Quincy, M.E.", runtimeMinutes: 50 },
      { name: "The Rockford Files", runtimeMinutes: 50 },
      { name: "Magnum, P.I.", runtimeMinutes: 48 },
      { name: "Knight Rider", runtimeMinutes: 48 },
      { name: "The A-Team", runtimeMinutes: 48 },
      { name: "Walker, Texas Ranger", runtimeMinutes: 45 },
      { name: "Baywatch", runtimeMinutes: 42 },
    ],
  },
  {
    id: "cozy-mysteries",
    name: "Cozy Mysteries",
    description: "A small daytime-friendly library. Too thin for late night, so watch the licensing panel.",
    library: [
      { name: "Murder, She Wrote", runtimeMinutes: 45 },
      { name: "Diagnosis: Murder", runtimeMinutes: 45 },
      { name: "Matlock", runtimeMinutes: 48 },
      { name: "Columbo", runtimeMinutes: 76 },
      { name: "Law", runtimeMinutes: 45 },
    ],
  },
];
