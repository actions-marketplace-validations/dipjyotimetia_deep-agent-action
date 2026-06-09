import type { Octokit } from "./client.js";
import type { GitHubContext, RunStatus } from "../types.js";
import type { TodoItem } from "../agent/stream.js";

const HEADER = "### 🤖 Deep Agent";

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
}

/** Render the single tracking-comment body from the current state. */
export function renderTrackingBody(state: TrackingState): string {
  const lines: string[] = [HEADER, ""];

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
  if (state.prUrl) lines.push("", `**Pull request:** ${state.prUrl}`);
  else if (state.branch) lines.push("", `**Branch:** \`${state.branch}\``);
  if (state.error) lines.push("", `> ${state.error}`);
  if (state.runUrl) lines.push("", `[View run](${state.runUrl})`);

  return lines.join("\n");
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
