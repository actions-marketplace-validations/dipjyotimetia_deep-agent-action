import { extractMemoryBlock } from "./memory.js";

/** GitHub's maximum comment body length (issue comments, review bodies, review comments). */
export const GITHUB_COMMENT_MAX_CHARS = 65536;

const TRUNCATION_NOTICE =
  "\n\n_…output truncated to fit GitHub's comment limit; see the run log for the full text._";

/**
 * Clamp a comment body to GitHub's length limit so the API call never fails on
 * an oversized body. Text is cut from the end — the hidden tracking marker is
 * always the first line, so it survives — and a trailing memory block is split
 * off and re-appended after the cut so cross-run memory survives truncation
 * intact (never cut mid-block).
 */
export function truncateBody(body: string, limit: number = GITHUB_COMMENT_MAX_CHARS): string {
  if (body.length <= limit) return body;
  const { rest, block } = extractMemoryBlock(body);
  const suffix = block ? `\n${block}` : "";
  const budget = limit - TRUNCATION_NOTICE.length - suffix.length;
  if (budget <= 0) {
    // The hidden block alone (nearly) exceeds the limit; drop it to keep the
    // visible text — a lost memory block degrades gracefully on the next run.
    return rest.slice(0, limit - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
  }
  return rest.slice(0, budget) + TRUNCATION_NOTICE + suffix;
}
