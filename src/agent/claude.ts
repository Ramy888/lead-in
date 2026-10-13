// Claude (Anthropic API) for Lead-In's agent and its "without Qloo" benchmark. Server-side only: the key comes
// from the environment. Claude Opus 5.5 with adaptive thinking (always on for this model; effort sets depth),
// prompt caching on the stable prefix, and server-side refusal fallbacks so a declined turn is retried on the
// model Anthropic recommends for that refusal category instead of ending the run.

import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5-5";

export type AgentMessage = Anthropic.Beta.BetaMessageParam;
export type AgentTool = Anthropic.Beta.BetaTool;
export type AgentReply = Anthropic.Beta.BetaMessage;

export interface TurnRequest {
  system: string;
  tools: AgentTool[];
  messages: AgentMessage[];
  /** JSON schema for the reply (structured output), for single-shot calls without tools. */
  schema?: Record<string, unknown>;
}

export interface TurnResult {
  message: AgentReply;
  /** Estimated cost of this call in USD, from list prices of the model that answered. */
  usd: number;
}

/** One model call. The agent loop and the benchmark depend on this, so tests can script it. */
export interface AgentModel {
  turn(req: TurnRequest, signal?: AbortSignal): Promise<TurnResult>;
}

/** List prices per token (USD), cache writes at 1.25x input. Fallback models are priced as themselves. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4e-6, output: 20e-6, cacheRead: 0.2e-6 },
  "claude-opus-5": { input: 5e-6, output: 25e-6, cacheRead: 0.5e-6 },
  "claude-opus-4-8": { input: 5e-6, output: 25e-6, cacheRead: 0.5e-6 },
};

export function costOf(message: Pick<AgentReply, "model" | "usage">): number {
  const p = PRICES[message.model] ?? PRICES["claude-opus-4-8"]!; // Unknown model: price at the higher Opus rate.
  const u = message.usage;
  return (
    u.input_tokens * p.input +
    (u.cache_creation_input_tokens ?? 0) * p.input * 1.25 +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead +
    u.output_tokens * p.output
  );
}

export interface ClaudeOptions {
  apiKey: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** Injected for tests; defaults to the SDK client. */
  client?: Anthropic;
}

export class ClaudeModel implements AgentModel {
  private readonly client: Anthropic;

  constructor(private readonly opts: ClaudeOptions) {
    if (!opts.client && !opts.apiKey) throw new Error("ANTHROPIC_API_KEY missing");
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2 });
  }

  async turn(req: TurnRequest, signal?: AbortSignal): Promise<TurnResult> {
    const message = await this.client.beta.messages.create(
      {
        model: MODEL,
        max_tokens: this.opts.maxTokens ?? 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // The system prompt and tool list never change within a run, so each turn re-reads them from cache.
        cache_control: { type: "ephemeral" },
        system: req.system,
        messages: req.messages,
        ...(req.tools.length ? { tools: req.tools } : {}),
        output_config: {
          effort: this.opts.effort ?? "medium",
          ...(req.schema ? { format: { type: "json_schema" as const, schema: req.schema } } : {}),
        },
      },
      { signal },
    );
    return { message, usd: costOf(message) };
  }
}
