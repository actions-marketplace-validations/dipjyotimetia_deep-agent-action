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

/**
 * Execution mode resolved from the event:
 *  - "agent": implement a change (edit files → branch/PR).
 *  - "review": review a PR diff and post inline comments (no edits).
 *  - "noop": nothing to do; exit cleanly.
 */
export type Mode = "agent" | "review" | "noop";

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
  /** Provider-prefixed model id, e.g. "anthropic:claude-sonnet-4-6". */
  model: string;
  /** Base URL for the `openai-compatible` provider (Groq, xAI, DeepSeek, Ollama, vLLM, …). */
  baseUrl?: string;
  allowedPermissions: string[];
  allowedCommands: string[];
  deniedCommands: string[];
  /** Label that a write-access user can apply to authorize a fork-PR run. */
  forkAllowLabel?: string;
  /** When true, gate landing of changes behind human review (draft PR / proposed branch). */
  requirePushApproval: boolean;
  /** Raw MCP server config JSON (optional); empty string when unset. */
  mcpConfig: string;
  shellTimeoutSeconds: number;
  /** Minimum interval between tracking-comment edits, ms. */
  commentDebounceMs: number;
  /** Abort the run once estimated spend reaches this many USD (needs a known model price). */
  maxCostUsd?: number;
  /** Abort the run once cumulative billed tokens (input + output) reach this many. */
  maxTotalTokens?: number;
}

/** Token usage for a run. */
export interface TokenUsage {
  input: number;
  output: number;
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
  tokens?: TokenUsage;
  costUsd?: number;
  /** True when changes were gated behind approval (draft PR / proposed branch). */
  approvalPending?: boolean;
  /** True when the run was stopped early by a cost/token budget ceiling. */
  budgetStopped?: boolean;
}
