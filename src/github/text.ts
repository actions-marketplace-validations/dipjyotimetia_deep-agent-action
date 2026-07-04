/** GitHub's maximum comment body length (issue comments, PR bodies, review bodies, review comments). */
export const GITHUB_COMMENT_MAX_CHARS = 65536;

const TRUNCATION_NOTICE =
  "\n\n_…output truncated to fit GitHub's comment limit; see the run log for the full text._";

/**
 * Clamp a body to GitHub's length limit so the API call never fails on an
 * oversized body. Text is cut from the end and a truncation notice appended.
 */
export function truncateBody(body: string, limit: number = GITHUB_COMMENT_MAX_CHARS): string {
  if (body.length <= limit) return body;
  return body.slice(0, Math.max(0, limit - TRUNCATION_NOTICE.length)) + TRUNCATION_NOTICE;
}
