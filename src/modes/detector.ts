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
 * True when the instruction asks the review to also apply its own suggested
 * fixes (e.g. "review and fix this PR"). Implies `isReviewRequest` — every
 * match here also starts with "review".
 */
export function isReviewAndFixRequest(instruction: string): boolean {
  return /^\s*review\s+(and|&)\s+fix\b/i.test(instruction);
}

/**
 * True when the instruction explicitly asks to resume a previously incomplete
 * plan (e.g. "continue" / "resume"). Deliberately opt-in — an unrelated
 * follow-up mention on the same thread should not silently reopen an old plan.
 */
export function isResumeRequest(instruction: string): boolean {
  return /^\s*(continue|resume)\b/i.test(instruction);
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
  opts: {
    triggerPhrase: string;
    prompt?: string;
    /** Label that bypasses the trigger-phrase check when just added to an issue. */
    autoRunLabel?: string;
    /** Assignee that bypasses the trigger-phrase check when just assigned to an issue. */
    autoRunAssignee?: string;
  },
): Mode {
  // workflow_dispatch (or any event) with an explicit prompt always runs the agent.
  if (opts.prompt && opts.prompt.trim()) return "agent";

  switch (ctx.eventName) {
    case "issue_comment":
    case "pull_request_review_comment":
      return checkContainsTrigger(ctx.triggerText, opts.triggerPhrase) ? "agent" : "noop";

    case "issues":
      if (!MENTIONABLE_ISSUE_ACTIONS.has(ctx.eventAction ?? "")) return "noop";
      if (opts.autoRunLabel && ctx.eventLabel === opts.autoRunLabel) return "agent";
      if (opts.autoRunAssignee && ctx.eventAssignee === opts.autoRunAssignee) return "agent";
      return checkContainsTrigger(ctx.triggerText, opts.triggerPhrase) ? "agent" : "noop";

    case "pull_request":
      if (!MENTIONABLE_PR_ACTIONS.has(ctx.eventAction ?? "")) return "noop";
      return checkContainsTrigger(ctx.triggerText, opts.triggerPhrase) ? "agent" : "noop";

    default:
      return "noop";
  }
}
