import { describe, expect, test } from "bun:test";
import { BudgetMeter, usageFromLLMResult } from "../src/agent/budget.js";

/** Build a minimal LLMResult-shaped object with usage_metadata on the message. */
function resultWithUsage(input: number, output: number): any {
  return {
    generations: [
      [{ text: "", message: { usage_metadata: { input_tokens: input, output_tokens: output } } }],
    ],
  };
}

describe("usageFromLLMResult", () => {
  test("reads usage_metadata from the generation message", () => {
    expect(usageFromLLMResult(resultWithUsage(120, 45))).toEqual({ input: 120, output: 45 });
  });

  test("falls back to llmOutput.tokenUsage (OpenAI shape)", () => {
    const out: any = {
      generations: [[{ text: "", message: {} }]],
      llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 7 } },
    };
    expect(usageFromLLMResult(out)).toEqual({ input: 10, output: 7 });
  });

  test("is zero when no usage is reported", () => {
    expect(usageFromLLMResult({ generations: [[{ text: "", message: {} }]] } as any)).toEqual({
      input: 0,
      output: 0,
    });
  });
});

describe("BudgetMeter", () => {
  const model = "anthropic:claude-sonnet-4-6";

  test("accumulates across calls and does not stop under the cap", () => {
    const controller = new AbortController();
    const meter = new BudgetMeter(model, { maxTotalTokens: 1000 }, controller);
    meter.handleLLMEnd(resultWithUsage(100, 50));
    meter.handleLLMEnd(resultWithUsage(100, 50));
    expect(meter.total).toEqual({ input: 200, output: 100 });
    expect(meter.stopped).toBeUndefined();
    expect(controller.signal.aborted).toBe(false);
  });

  test("aborts exactly when the token ceiling is crossed", () => {
    const controller = new AbortController();
    const meter = new BudgetMeter(model, { maxTotalTokens: 250 }, controller);
    meter.handleLLMEnd(resultWithUsage(100, 50)); // 150, under
    expect(meter.stopped).toBeUndefined();
    meter.handleLLMEnd(resultWithUsage(100, 50)); // 300, over
    expect(meter.stopped).toBe("budget");
    expect(controller.signal.aborted).toBe(true);
    expect(meter.reason).toContain("token budget");
  });

  test("keeps metering subagent-style calls but aborts only once", () => {
    const controller = new AbortController();
    let aborts = 0;
    controller.signal.addEventListener("abort", () => aborts++);
    const meter = new BudgetMeter(model, { maxTotalTokens: 100 }, controller);
    meter.handleLLMEnd(resultWithUsage(60, 60)); // over -> abort
    meter.handleLLMEnd(resultWithUsage(60, 60)); // still tallies, no second abort
    expect(meter.total).toEqual({ input: 120, output: 120 });
    expect(aborts).toBe(1);
  });
});
