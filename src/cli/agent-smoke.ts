// One live agent run: Claude Opus 5.5 + Qloo (cached). Costs some cents on the Anthropic API.
// npm run agent:smoke -- "your brief"

import { runAgent } from "../agent/agent.js";
import { ClaudeModel } from "../agent/claude.js";
import { PRESETS } from "../presets.js";
import { qlooFromEnv } from "../qloo/from-env.js";
import { TracingClient } from "../qloo/trace.js";
import { flowScore } from "../server/view.js";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw new Error("ANTHROPIC_API_KEY missing (../.env)");
const qloo = qlooFromEnv();
const client = new TracingClient(qloo);
const brief = process.argv[2] ?? "Late night feels weak and the action block hands off badly. I can license one or two titles.";
const started = Date.now();
const result = await runAgent({ model: new ClaudeModel({ apiKey: key }), qloo: client }, { library: PRESETS[Number(process.env.PRESET ?? 0)]!.library, brief }, (e) => {
  if (e.type === "agent_call") console.log(`[${e.step}] → ${e.tool} ${JSON.stringify(e.args).slice(0, 160)}`);
  else if (e.type === "agent_result_step") console.log(`[${e.step}] ${e.ok ? "✓" : "✗"} ${e.summary}`);
  else console.log(`[${e.step}] note: ${e.text.slice(0, 200)}`);
});
qloo.flush();
console.log("\nRECOMMENDATION:", result.recommendation);
for (const q of result.qlooEvidence) console.log("  Qloo says:", q);
for (const o of result.ourRead) console.log("  Our read:", o);
console.log("adopted:", result.adopted ? `${result.adopted.id} +[${result.adopted.add}] -[${result.adopted.remove}] flow ${flowScore(result.baseline.schedule.slots)} → ${flowScore(result.adopted.plan.schedule.slots)}` : "none");
console.log(`usage: ${result.usage.llmCalls} LLM calls, ${result.usage.promptTokens}+${result.usage.completionTokens} tokens, $${result.usage.usd.toFixed(4)} (${result.usage.models}); Qloo calls ${client.trace.length} (${client.trace.filter((t) => t.cached).length} cached); ${Math.round((Date.now() - started) / 1000)}s${result.stoppedBecause ? "; stopped: " + result.stoppedBecause : ""}`);
