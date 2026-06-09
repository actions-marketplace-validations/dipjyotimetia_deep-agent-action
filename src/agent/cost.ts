import type { TokenUsage } from "../types.js";

/** Rough USD price per 1M tokens, matched by model-name substring. Estimates only. */
const PRICES: ReadonlyArray<{ match: RegExp; inPerM: number; outPerM: number }> = [
  { match: /claude.*opus/i, inPerM: 15, outPerM: 75 },
  { match: /claude.*sonnet/i, inPerM: 3, outPerM: 15 },
  { match: /claude.*haiku/i, inPerM: 1, outPerM: 5 },
  { match: /gpt.*mini|o\d.*mini/i, inPerM: 0.6, outPerM: 2.4 },
  { match: /gpt|o\d/i, inPerM: 2.5, outPerM: 10 },
  { match: /gemini.*flash/i, inPerM: 0.3, outPerM: 2.5 },
  { match: /gemini/i, inPerM: 1.25, outPerM: 10 },
];

/**
 * Estimate run cost in USD from token usage, matched by model name.
 * Returns undefined for unknown models (caller reports tokens only).
 */
export function estimateCostUsd(model: string, tokens: TokenUsage): number | undefined {
  const price = PRICES.find((p) => p.match.test(model));
  if (!price) return undefined;
  const usd =
    (tokens.input / 1_000_000) * price.inPerM + (tokens.output / 1_000_000) * price.outPerM;
  return Math.round(usd * 10_000) / 10_000;
}
