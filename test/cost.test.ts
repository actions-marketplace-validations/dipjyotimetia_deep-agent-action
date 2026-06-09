import { describe, expect, test } from "bun:test";
import { estimateCostUsd } from "../src/agent/cost.js";

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
