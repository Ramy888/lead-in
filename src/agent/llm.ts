// NVIDIA Nemotron on Nebius Token Factory (OpenAI-compatible chat completions with tool calling).
// Server-side only; the key comes from the environment and travels in a header.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Estimated cost of this call in USD, from the model's list price. */
  usd: number;
}

export interface ChatModel {
  chat(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<ChatResult>;
}

/** List prices per token (USD), from Token Factory's /v1/models on 2026-10-13. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "nvidia/Nemotron-3-Ultra-550b-a55b": { input: 1.0e-6, output: 3.0e-6 },
  "nvidia/nemotron-3-super-120b-a12b": { input: 0.3e-6, output: 0.9e-6 },
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { input: 0.06e-6, output: 0.24e-6 },
};

export const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
export const SUPER = "nvidia/nemotron-3-super-120b-a12b";

export interface NemotronOptions {
  apiKey: string;
  /** Tried in order: the next model is used when one errors or is rate-limited. */
  models?: string[];
  baseUrl?: string;
  fetchFn?: typeof fetch;
  maxTokens?: number;
  timeoutMs?: number;
}

export class NemotronClient implements ChatModel {
  private readonly fetchFn: typeof fetch;
  private readonly models: string[];

  constructor(private readonly opts: NemotronOptions) {
    if (!opts.apiKey) throw new Error("NEBIUS_API_KEY missing");
    // Wrapped, not stored bare: Workers throw "Illegal invocation" if fetch is called with `this` = the client.
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.models = opts.models ?? [ULTRA, SUPER];
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<ChatResult> {
    let lastError = "no model answered";
    for (const model of this.models) {
      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 45_000);
      let res: Response;
      try {
        res = await this.fetchFn(`${this.opts.baseUrl ?? "https://api.tokenfactory.nebius.com/v1"}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, tools, tool_choice: "auto", max_tokens: this.opts.maxTokens ?? 1500, temperature: 0.3 }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = `${model}: ${err instanceof Error ? err.message : "network error"}`;
        continue;
      }
      if (!res.ok) {
        lastError = `${model}: HTTP ${res.status}`;
        continue; // 429 and 5xx fall through to the next model; so do 4xx, which a fallback can't make worse.
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const message = body.choices?.[0]?.message;
      const promptTokens = body.usage?.prompt_tokens ?? 0;
      const completionTokens = body.usage?.completion_tokens ?? 0;
      const price = PRICES[model] ?? PRICES[ULTRA]!;
      return {
        content: message?.content ?? "",
        toolCalls: message?.tool_calls ?? [],
        model,
        promptTokens,
        completionTokens,
        usd: promptTokens * price.input + completionTokens * price.output,
      };
    }
    throw new Error(`Nemotron unavailable (${lastError})`);
  }
}
