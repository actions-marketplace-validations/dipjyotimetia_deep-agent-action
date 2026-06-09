/**
 * Shared types for the Deep Agent Action control plane.
 */

/** GitHub events this action understands. */
export type SupportedEventName =
  | "issue_comment"
  | "pull_request_review_comment"
  | "issues"
  | "pull_request"
  | "workflow_dispatch";

/** Execution mode resolved from the event. v1 supports "agent" or "noop". */
export type Mode = "agent" | "noop";

/** Normalized, provider-agnostic view of the triggering GitHub event. */
export interface GitHubContext {
  eventName: string;
  eventAction?: string;
  owner: string;
  repo: string;
  /** The login of the actor that triggered the run. */
  actor: string;
  /** Issue or PR number, when the event is tied to one. */
  entityNumber?: number;
  /** True when the event is attached to a pull request (PR, PR review comment, or issue_comment on a PR). */
  isPR: boolean;
  /** The comment / issue / PR body text that may contain the trigger phrase. */
  triggerText?: string;
  /** The id of the comment that triggered the run, when applicable. */
  commentId?: number;
  /** True when this is a PR review comment (uses the pulls review-comment API). */
  isPullRequestReviewComment: boolean;
  /** Fork info for PR events. */
  prHeadRepoFullName?: string;
  prBaseRepoFullName?: string;
  prHeadRef?: string;
  /** Labels on the issue/PR, used for maintainer gating of fork runs. */
  labels: string[];
  /** Raw event payload for anything not normalized above. */
  payload: unknown;
}

/** Parsed and normalized action inputs. */
export interface Config {
  triggerPhrase: string;
  /** Explicit prompt for workflow_dispatch (bypasses the phrase). */
  prompt?: string;
  /** Provider-prefixed model id, e.g. "anthropic:claude-sonnet-4-5". */
  model: string;
  allowedPermissions: string[];
  allowedCommands: string[];
  deniedCommands: string[];
  /** Label that a write-access user can apply to authorize a fork-PR run. */
  forkAllowLabel?: string;
  /** Reserved for P1-1 (not implemented in v1). */
  requirePushApproval: boolean;
  shellTimeoutSeconds: number;
  /** Minimum interval between tracking-comment edits, ms. */
  commentDebounceMs: number;
}

/** Outcome status surfaced as the `status` output. */
export type RunStatus = "success" | "skipped" | "refused" | "failed";

/** One recorded tool invocation for the audit record. */
export interface ToolCallRecord {
  name: string;
  args?: unknown;
  blocked?: boolean;
  reason?: string;
}

/** Structured, retained record of a run (the `result_json` output + artifact). */
export interface RunRecord {
  status: RunStatus;
  mode: Mode;
  model: string;
  instruction?: string;
  plan: { content: string; status: string }[];
  toolCalls: ToolCallRecord[];
  filesChanged: string[];
  prUrl?: string;
  branch?: string;
  summary?: string;
  error?: string;
}
