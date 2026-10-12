// Contract for the Qloo harness tools (`qloo mcp` / `qloo exec`). Every tool answers with the same
// envelope; callers must handle needs_input (ambiguous entity) by showing candidates, not guessing.

export const QLOO_TOOLS = [
  "qloo_find_tags",
  "qloo_describe",
  "qloo_recommend",
  "qloo_rank",
  "qloo_where_popular",
  "qloo_compare_audiences",
  "qloo_audience_demographics",
  "qloo_entity_tags",
  "qloo_trends",
] as const;

export type QlooTool = (typeof QLOO_TOOLS)[number];

export type EnvelopeStatus = "ok" | "empty" | "needs_input" | "partial" | "degraded" | "error";

export interface Candidate {
  id: string;
  name: string;
  hint?: string;
}

export interface Envelope<T> {
  status: EnvelopeStatus;
  data?: T;
  candidates?: Candidate[];
  error?: { code: string; message: string; recovery?: string };
}

export interface Entity {
  id: string;
  name: string;
  type: "tv_show" | "movie" | "artist" | "podcast" | "brand" | "place" | "person" | "book" | "destination" | "video_game";
}

export interface Recommendation {
  entity: Entity;
  /** Qloo affinity, 0..1. */
  affinity: number;
}

/** Aggregate audience skew. Values are relative indices around 0 (−1 under-indexed … +1 over-indexed). */
export interface Demographics {
  age: Partial<Record<AgeBand, number>>;
  gender: Partial<Record<"female" | "male", number>>;
}

export type AgeBand = "24_and_younger" | "25_to_29" | "30_to_34" | "35_to_44" | "45_to_54" | "55_and_older";

export interface CompareResult {
  /** Audience overlap between the two groups, 0..1. Symmetric. */
  overlap: number;
}

/** The subset of tools Lead-In uses, typed. Real and fake clients both implement this. */
export interface QlooClient {
  describe(name: string, type: Entity["type"]): Promise<Envelope<Entity>>;
  recommend(signals: Entity[], targetType: Entity["type"], limit: number): Promise<Envelope<Recommendation[]>>;
  audienceDemographics(entity: Entity): Promise<Envelope<Demographics>>;
  compareAudiences(a: Entity[], b: Entity[]): Promise<Envelope<CompareResult>>;
}
