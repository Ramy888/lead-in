// SYNTHETIC stand-in for Qloo until the hackathon key arrives. Show names are real; every number here is
// invented from a small taste-feature model so the pipeline can be built and tested. Nothing in this file
// is "what Qloo says" and the UI must label it as synthetic.

import type {
  AgeBand,
  CompareResult,
  Demographics,
  Entity,
  Envelope,
  QlooClient,
  Recommendation,
} from "./types.js";

// Taste features: cozy mystery, procedural, action, glam/beach, legal, comedy. Plus a popularity weight.
type Features = [number, number, number, number, number, number];
interface Synthetic {
  name: string;
  f: Features;
  popularity: number;
}

const CATALOG: Synthetic[] = [
  { name: "Columbo", f: [0.7, 0.8, 0.1, 0.0, 0.1, 0.2], popularity: 0.8 },
  { name: "Murder, She Wrote", f: [1.0, 0.5, 0.0, 0.0, 0.1, 0.2], popularity: 0.9 },
  { name: "Matlock", f: [0.6, 0.3, 0.0, 0.0, 1.0, 0.2], popularity: 0.7 },
  { name: "Perry Mason", f: [0.5, 0.4, 0.0, 0.0, 1.0, 0.0], popularity: 0.6 },
  { name: "Diagnosis: Murder", f: [0.9, 0.5, 0.1, 0.0, 0.0, 0.3], popularity: 0.6 },
  { name: "Quincy, M.E.", f: [0.4, 0.9, 0.1, 0.0, 0.1, 0.0], popularity: 0.5 },
  { name: "The Rockford Files", f: [0.3, 0.6, 0.5, 0.1, 0.0, 0.4], popularity: 0.6 },
  { name: "Magnum, P.I.", f: [0.2, 0.5, 0.6, 0.4, 0.0, 0.4], popularity: 0.7 },
  { name: "Knight Rider", f: [0.0, 0.2, 0.9, 0.4, 0.0, 0.2], popularity: 0.7 },
  { name: "The A-Team", f: [0.0, 0.1, 1.0, 0.2, 0.0, 0.5], popularity: 0.7 },
  { name: "Walker, Texas Ranger", f: [0.1, 0.4, 0.9, 0.0, 0.0, 0.0], popularity: 0.6 },
  { name: "Baywatch", f: [0.0, 0.1, 0.5, 1.0, 0.0, 0.2], popularity: 0.8 },
  // Not in the demo library: candidates the "license these" panel can surface.
  { name: "Father Dowling Mysteries", f: [0.9, 0.4, 0.0, 0.0, 0.1, 0.3], popularity: 0.4 },
  { name: "Hart to Hart", f: [0.6, 0.4, 0.2, 0.4, 0.0, 0.4], popularity: 0.5 },
  { name: "Simon & Simon", f: [0.3, 0.5, 0.5, 0.1, 0.0, 0.4], popularity: 0.5 },
  { name: "In the Heat of the Night", f: [0.3, 0.8, 0.4, 0.0, 0.1, 0.0], popularity: 0.5 },
  { name: "Silk Stalkings", f: [0.1, 0.5, 0.3, 0.8, 0.0, 0.0], popularity: 0.3 },
  { name: "Law & Order", f: [0.2, 1.0, 0.1, 0.0, 0.7, 0.0], popularity: 0.9 },
  { name: "Law & Order: Special Victims Unit", f: [0.1, 1.0, 0.2, 0.0, 0.5, 0.0], popularity: 0.9 },
];

const idOf = (name: string) => "SYN-" + name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
const toEntity = (s: Synthetic): Entity => ({ id: idOf(s.name), name: s.name, type: "tv_show" });
const round = (x: number) => Math.round(x * 1000) / 1000;

function cosine(a: Features, b: Features): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function find(entity: Entity): Synthetic | undefined {
  return CATALOG.find((s) => idOf(s.name) === entity.id);
}

/** Mean feature vector of a group, so group signals behave like a blended taste. */
function blend(group: Entity[]): Features | undefined {
  const items = group.map(find).filter((s): s is Synthetic => !!s);
  if (!items.length) return undefined;
  const out: Features = [0, 0, 0, 0, 0, 0];
  for (const s of items) s.f.forEach((v, i) => (out[i] = out[i]! + v / items.length));
  return out;
}

export class FakeQlooClient implements QlooClient {
  readonly synthetic = true;

  async describe(name: string, type: Entity["type"]): Promise<Envelope<Entity>> {
    if (type !== "tv_show") return { status: "empty" };
    const q = name.trim().toLowerCase();
    const exact = CATALOG.find((s) => s.name.toLowerCase() === q);
    if (exact) return { status: "ok", data: toEntity(exact) };
    const partial = CATALOG.filter((s) => s.name.toLowerCase().includes(q));
    if (partial.length === 1) return { status: "ok", data: toEntity(partial[0]!) };
    if (partial.length > 1) {
      return { status: "needs_input", candidates: partial.map((s) => ({ id: idOf(s.name), name: s.name })) };
    }
    return { status: "empty" };
  }

  async recommend(signals: Entity[], targetType: Entity["type"], limit: number): Promise<Envelope<Recommendation[]>> {
    const taste = blend(signals);
    if (!taste || targetType !== "tv_show") return { status: "empty", data: [] };
    const exclude = new Set(signals.map((s) => s.id));
    // Popular titles get a lift in recommendation lists; that is what makes affinity asymmetric.
    const recs = CATALOG.filter((s) => !exclude.has(idOf(s.name)))
      .map((s) => ({ entity: toEntity(s), affinity: round(cosine(taste, s.f) * (0.6 + 0.4 * s.popularity)) }))
      .sort((a, b) => b.affinity - a.affinity)
      .slice(0, limit);
    return { status: recs.length ? "ok" : "empty", data: recs };
  }

  async audienceDemographics(entity: Entity): Promise<Envelope<Demographics>> {
    const s = find(entity);
    if (!s) return { status: "empty" };
    const [cozy, proc, action, glam, legal, comedy] = s.f;
    const older = 0.6 * cozy + 0.5 * legal + 0.2 * proc - 0.4 * glam - 0.2 * action;
    const age: Record<AgeBand, number> = {
      "24_and_younger": round(-0.5 * older + 0.3 * glam),
      "25_to_29": round(-0.3 * older + 0.3 * glam + 0.1 * comedy),
      "30_to_34": round(-0.2 * older + 0.2 * action),
      "35_to_44": round(0.3 * action + 0.1 * proc - 0.1 * cozy),
      "45_to_54": round(0.2 * action + 0.2 * proc + 0.1 * older),
      "55_and_older": round(older),
    };
    const femaleLean = 0.5 * cozy + 0.2 * legal - 0.5 * action + 0.1 * glam;
    return { status: "ok", data: { age, gender: { female: round(femaleLean), male: round(-femaleLean) } } };
  }

  async compareAudiences(a: Entity[], b: Entity[]): Promise<Envelope<CompareResult>> {
    const fa = blend(a), fb = blend(b);
    if (!fa || !fb) return { status: "empty" };
    return { status: "ok", data: { overlap: round(cosine(fa, fb)) } };
  }
}
