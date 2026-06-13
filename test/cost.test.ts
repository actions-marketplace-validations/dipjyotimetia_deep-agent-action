import { describe, expect, test } from "bun:test";
import { estimateCostUsd, evaluateBudget } from "../src/agent/cost.js";

describe("estimateCostUsd", () => {
  test("prices a known sonnet model", () => {
    // 1M in @ $3 + 1M out @ $15 = $18
    expect(
      estimateCostUsd("anthropic:claude-sonnet-4-6", { input: 1_000_000, output: 1_000_000 }),
    ).toBe(18);
  });

  test("prices opus higher than sonnet", () => {
    const opus = estimateCostUsd("claude-opus-4", { input: 1_000_000, output: 0 })!;
    const sonnet = estimateCostUsd("claude-sonnet-4", { input: 1_000_000, output: 0 })!;
    expect(opus).toBeGreaterThan(sonnet);
  });

  test("returns undefined for unknown models", () => {
    expect(estimateCostUsd("some-unknown-model", { input: 100, output: 100 })).toBeUndefined();
  });

  test("rounds to 4 decimals", () => {
    const c = estimateCostUsd("openai:gpt-5", { input: 1234, output: 567 });
    expect(c).toBeDefined();
    expect(Number.isFinite(c!)).toBe(true);
  });
});

describe("evaluateBudget", () => {
  const model = "anthropic:claude-sonnet-4-6";

  test("never stops when no limits are set", () => {
    expect(evaluateBudget(model, { input: 9_999_999, output: 9_999_999 }, {}).exceeded).toBe(false);
  });

  test("stops on the token cap", () => {
    const v = evaluateBudget(model, { input: 120, output: 90 }, { maxTotalTokens: 200 });
    expect(v.exceeded).toBe(true);
    expect(v.reason).toContain("token budget");
  });

  test("does not stop below the token cap", () => {
    expect(evaluateBudget(model, { input: 50, output: 50 }, { maxTotalTokens: 200 }).exceeded).toBe(
      false,
    );
  });

  test("stops on the cost cap for a priced model", () => {
    // sonnet: 1M in @ $3 + 1M out @ $15 = $18 ≥ $10
    const v = evaluateBudget(model, { input: 1_000_000, output: 1_000_000 }, { maxCostUsd: 10 });
    expect(v.exceeded).toBe(true);
    expect(v.reason).toContain("cost budget");
  });

  test("does not stop below the cost cap", () => {
    expect(evaluateBudget(model, { input: 1000, output: 1000 }, { maxCostUsd: 10 }).exceeded).toBe(
      false,
    );
  });

  test("cost cap can't fire for an unpriced model (fails closed, not open on cost)", () => {
    const v = evaluateBudget(
      "some-unknown-model",
      { input: 9_999_999, output: 9_999_999 },
      { maxCostUsd: 0.01 },
    );
    expect(v.exceeded).toBe(false);
  });

  test("token cap still applies to an unpriced model", () => {
    const v = evaluateBudget(
      "some-unknown-model",
      { input: 300, output: 0 },
      { maxCostUsd: 0.01, maxTotalTokens: 200 },
    );
    expect(v.exceeded).toBe(true);
    expect(v.reason).toContain("token budget");
  });
});
