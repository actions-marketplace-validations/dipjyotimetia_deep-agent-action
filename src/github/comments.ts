import type { Octokit } from "./client.js";
import type { GitHubContext, RunStatus, TokenUsage } from "../types.js";
import type { TodoItem } from "../agent/stream.js";
import { renderMemoryBlock, type MemoryTurn } from "./memory.js";

const HEADER = "### 🤖 Deep Agent";
/** Hidden marker used to find this run's sticky tracking comment on re-runs. */
const MARKER = "<!-- deep-agent:tracking -->";

function checkbox(status: string): string {
  if (status === "completed") return "- [x]";
  if (status === "in_progress") return "- [ ] ⏳";
  return "- [ ]";
}

export interface TrackingState {
  status: RunStatus | "working";
  todos?: TodoItem[];
  instruction?: string;
  prUrl?: string;
  branch?: string;
  summary?: string;
  error?: string;
  runUrl?: string;
  tokens?: TokenUsage;
  costUsd?: number;
  /** When true, changes are gated behind human review (draft PR / proposed branch). */
  approvalPending?: boolean;
  /** When true, the run was stopped early by a budget ceiling; show a banner. */
  budgetStopped?: boolean;
  /** Per-thread turn history, stored as a hidden block for the next run to read. */
  memory?: MemoryTurn[];
}

/** Render the single tracking-comment body from the current state. */
export function renderTrackingBody(state: TrackingState): string {
  const lines: string[] = [MARKER, HEADER, ""];

  switch (state.status) {
    case "working":
      lines.push("Working on it…");
      break;
    case "success":
      lines.push("✅ Done.");
      break;
    case "skipped":
      lines.push("Nothing to do.");
      break;
    case "refused":
      lines.push("⛔ Request not authorized.");
      break;
    case "failed":
      lines.push("❌ The run failed.");
      break;
  }

  if (state.todos && state.todos.length) {
    lines.push("", "**Plan**");
    for (const t of state.todos) lines.push(`${checkbox(t.status)} ${t.content}`);
  }

  if (state.summary) lines.push("", state.summary);
  if (state.approvalPending && state.prUrl) {
    lines.push(
      "",
      `**Draft pull request (awaiting approval):** ${state.prUrl}`,
      "Mark it ready / merge to apply the changes.",
    );
  } else if (state.approvalPending && state.branch) {
    lines.push(
      "",
      `**Proposed branch (awaiting approval):** \`${state.branch}\``,
      "Review and merge it into the PR branch to apply the changes.",
    );
  } else if (state.prUrl) {
    lines.push("", `**Pull request:** ${state.prUrl}`);
  } else if (state.branch) {
    lines.push("", `**Branch:** \`${state.branch}\``);
  }
  if (state.budgetStopped) {
    lines.push(
      "",
      "⚠️ Stopped at the configured budget cap — any partial changes were opened for review.",
    );
  }
  if (state.tokens && (state.tokens.input || state.tokens.output)) {
    const cost = state.costUsd != null ? ` (~$${state.costUsd.toFixed(4)})` : "";
    lines.push("", `_Tokens: ${state.tokens.input} in / ${state.tokens.output} out${cost}_`);
  }
  if (state.error) lines.push("", `> ${state.error}`);
  if (state.runUrl) lines.push("", `[View run](${state.runUrl})`);

  // Hidden, machine-only block: per-thread memory for the next run to read.
  if (state.memory && state.memory.length) lines.push("", renderMemoryBlock(state.memory));

  return lines.join("\n");
}

/**
 * Find an existing sticky tracking comment on the issue/PR (by hidden marker).
 * Returns its id and body — the body carries the hidden cross-run memory block.
 */
export async function findTrackingComment(
  octokit: Octokit,
  ctx: GitHubContext,
): Promise<{ id: number; body: string } | undefined> {
  if (ctx.entityNumber == null) return undefined;
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.entityNumber,
      per_page: 100,
    });
    const found = comments.find((c) => typeof c.body === "string" && c.body.includes(MARKER));
    return found ? { id: found.id, body: found.body ?? "" } : undefined;
  } catch {
    return undefined;
  }
}

/** Add an "eyes" reaction to the triggering comment/issue (best-effort). */
export async function addEyesReaction(octokit: Octokit, ctx: GitHubContext): Promise<void> {
  const base = { owner: ctx.owner, repo: ctx.repo, content: "eyes" as const };
  try {
    if (ctx.eventName === "issue_comment" && ctx.commentId != null) {
      await octokit.rest.reactions.createForIssueComment({ ...base, comment_id: ctx.commentId });
    } else if (ctx.isPullRequestReviewComment && ctx.commentId != null) {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        ...base,
        comment_id: ctx.commentId,
      });
    } else if (ctx.entityNumber != null) {
      await octokit.rest.reactions.createForIssue({ ...base, issue_number: ctx.entityNumber });
    }
  } catch {
    // Reactions are advisory; never fail the run over them.
  }
}

/** Create the tracking comment on the issue/PR and return its id. */
export async function createTrackingComment(
  octokit: Octokit,
  ctx: GitHubContext,
  body: string,
): Promise<number | undefined> {
  if (ctx.entityNumber == null) return undefined;
  const res = await octokit.rest.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.entityNumber,
    body,
  });
  return res.data.id;
}

/** Update the tracking comment in place. */
export async function updateTrackingComment(
  octokit: Octokit,
  ctx: GitHubContext,
  commentId: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.updateComment({
    owner: ctx.owner,
    repo: ctx.repo,
    comment_id: commentId,
    body,
  });
}
