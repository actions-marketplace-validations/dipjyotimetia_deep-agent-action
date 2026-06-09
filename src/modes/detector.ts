import type { GitHubContext, Mode } from "../types.js";
import { checkContainsTrigger } from "../github/validation/trigger.js";

/** PR actions that could carry a mention-triggered instruction. */
const MENTIONABLE_PR_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "edited"]);
const MENTIONABLE_ISSUE_ACTIONS = new Set(["opened", "reopened", "edited", "assigned", "labeled"]);

/** True when the instruction asks for a code review (e.g. "review this PR"). */
export function isReviewRequest(instruction: string): boolean {
  return /^\s*review\b/i.test(instruction);
}

/**
 * Decide whether this event should trigger the agent or be a no-op. The
 * agent-vs-review distinction is refined by the caller from the resolved
 * instruction (see isReviewRequest), since review only applies on PRs.
 *
 * Review behaviour on bare `pull_request` events (no mention) is deferred, so
 * those resolve to "noop".
 */
export function detectMode(
  ctx: GitHubContext,
  opts: { triggerPhrase: string; prompt?: string },
): Mode {
  // workflow_dispatch (or any event) with an explicit prompt always runs the agent.
  if (opts.prompt && opts.prompt.trim()) return "agent";

  switch (ctx.eventName) {
    case "issue_comment":
    case "pull_request_review_comment":
      return checkContainsTrigger(ctx.triggerText, opts.triggerPhrase) ? "agent" : "noop";

    case "issues":
      if (!MENTIONABLE_ISSUE_ACTIONS.has(ctx.eventAction ?? "")) return "noop";
      return checkContainsTrigger(ctx.triggerText, opts.triggerPhrase) ? "agent" : "noop";

    case "pull_request":
      if (!MENTIONABLE_PR_ACTIONS.has(ctx.eventAction ?? "")) return "noop";
      return checkContainsTrigger(ctx.triggerText, opts.triggerPhrase) ? "agent" : "noop";

    default:
      return "noop";
  }
}
