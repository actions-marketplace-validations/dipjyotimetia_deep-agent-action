import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { TokenUsage } from "../types.js";
import { evaluateBudget, type BudgetLimits } from "./cost.js";

/**
 * Pull token usage out of one LLM result. Prefers the modern `usage_metadata`
 * on the generation message (what every provider the action supports reports),
 * falling back to the older `llmOutput.tokenUsage` shape. Providers that report
 * neither contribute zero — the same blind spot the post-run cost estimate has.
 */
export function usageFromLLMResult(output: LLMResult): TokenUsage {
  let input = 0;
  let out = 0;
  for (const generation of output.generations ?? []) {
    for (const g of generation) {
      const msg = (g as { message?: { usage_metadata?: unknown } }).message;
      const um = msg?.usage_metadata as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      if (um) {
        input += um.input_tokens ?? 0;
        out += um.output_tokens ?? 0;
      }
    }
  }
  if (input === 0 && out === 0 && output.llmOutput) {
    const tu = (output.llmOutput.tokenUsage ?? output.llmOutput.usage) as
      | {
          promptTokens?: number;
          completionTokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
        }
      | undefined;
    if (tu) {
      input += tu.promptTokens ?? tu.prompt_tokens ?? tu.input_tokens ?? 0;
      out += tu.completionTokens ?? tu.completion_tokens ?? tu.output_tokens ?? 0;
    }
  }
  return { input, output: out };
}

/**
 * A callback handler that meters cumulative token spend across every model call
 * — the main agent AND its subagents — and aborts the run the instant a budget
 * ceiling is crossed.
 *
 * The meter must be a callback, not a stream-loop check: `deepagents` runs
 * subagents via an opaque `subagent.invoke(...)` that returns only a single
 * ToolMessage to the parent, so subagent token usage never appears in the
 * parent's streamed messages. A message-summing cap would silently undercount
 * (fail open). Since the subagent invoke spreads the parent run config, this
 * handler's `handleLLMEnd` fires for subagent calls too, and aborting via the
 * shared AbortController interrupts even mid-subagent.
 */
export class BudgetMeter extends BaseCallbackHandler {
  name = "BudgetMeter";
  readonly total: TokenUsage = { input: 0, output: 0 };
  /** Set to "budget" once a ceiling is crossed and the run is aborted. */
  stopped: "budget" | undefined;
  reason: string | undefined;

  constructor(
    private readonly model: string,
    private readonly limits: BudgetLimits,
    private readonly controller: AbortController,
  ) {
    super();
  }

  handleLLMEnd(output: LLMResult): void {
    const usage = usageFromLLMResult(output);
    this.total.input += usage.input;
    this.total.output += usage.output;
    if (this.stopped) return;
    const verdict = evaluateBudget(this.model, this.total, this.limits);
    if (verdict.exceeded) {
      this.stopped = "budget";
      this.reason = verdict.reason;
      this.controller.abort();
    }
  }
}
