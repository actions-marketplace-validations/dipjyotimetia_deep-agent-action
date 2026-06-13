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

/** Optional ceilings for a run; either, both, or neither may be set. */
export interface BudgetLimits {
  /** Stop once estimated spend reaches this many USD (needs a known model price). */
  maxCostUsd?: number;
  /** Stop once cumulative billed tokens (input + output) reach this many. */
  maxTotalTokens?: number;
}

export interface BudgetVerdict {
  exceeded: boolean;
  reason?: string;
}

/**
 * Decide whether accumulated usage has crossed a configured ceiling. Pure.
 *
 * The token cap always applies. The cost cap only applies when the model has a
 * known price (`estimateCostUsd` returns a number) — an unpriced model can't be
 * cost-capped, so callers should pair `maxCostUsd` with `maxTotalTokens` for
 * those. Returns `{ exceeded: false }` when neither limit is set.
 */
export function evaluateBudget(
  model: string,
  tokens: TokenUsage,
  limits: BudgetLimits,
): BudgetVerdict {
  const total = tokens.input + tokens.output;
  if (limits.maxTotalTokens != null && total >= limits.maxTotalTokens) {
    return { exceeded: true, reason: `token budget reached (${total} ≥ ${limits.maxTotalTokens})` };
  }
  if (limits.maxCostUsd != null) {
    const cost = estimateCostUsd(model, tokens);
    if (cost != null && cost >= limits.maxCostUsd) {
      return {
        exceeded: true,
        reason: `cost budget reached (~$${cost.toFixed(4)} ≥ $${limits.maxCostUsd})`,
      };
    }
  }
  return { exceeded: false };
}
