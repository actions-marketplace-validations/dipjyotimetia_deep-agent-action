import type { Octokit } from "./client.js";
import type { GitHubContext } from "../types.js";
import { MARKER } from "./comments.js";

/** Most recent human comments included in the rendered context. */
const MAX_COMMENTS = 15;
/** Per-comment character cap so one huge comment can't blow up the prompt. */
const MAX_COMMENT_CHARS = 1500;
/** Cap on the issue/PR description itself. */
const MAX_BODY_CHARS = 3000;

function clip(text: string, limit: number): string {
  const t = text.trim();
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

export interface ThreadInfo {
  /** The bot's own sticky tracking comment on this thread, if one exists. */
  trackingComment?: { id: number; body: string };
  /**
   * Rendered title, description, and recent human comments for the issue/PR —
   * everything beyond the single comment that triggered this run, so the
   * agent sees the whole conversation instead of one isolated fragment.
   */
  context?: string;
}

/**
 * Fetch an issue/PR thread once: title/body, and every comment (used both to
 * locate our own sticky tracking comment and to render prior human comments
 * as context, avoiding a second paginated call for the same data). Best
 * effort — degrades to `{}` on any API failure so a run never fails because
 * this extra context couldn't be fetched.
 */
export async function fetchThread(octokit: Octokit, ctx: GitHubContext): Promise<ThreadInfo> {
  if (ctx.entityNumber == null) return {};
  try {
    const [{ data: entity }, comments] = await Promise.all([
      octokit.rest.issues.get({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.entityNumber,
      }),
      octokit.paginate(octokit.rest.issues.listComments, {
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.entityNumber,
        per_page: 100,
      }),
    ]);

    const tracking = comments.find((c) => typeof c.body === "string" && c.body.includes(MARKER));

    // Exclude the triggering comment itself (already delivered as the
    // instruction) and our own tracking comment (already delivered via
    // cross-run memory) — everything else is prior human conversation.
    const priorComments = comments
      .filter((c) => c.id !== ctx.commentId && c !== tracking)
      .slice(-MAX_COMMENTS)
      .map((c) => `**${c.user?.login ?? "unknown"}:**\n${clip(c.body ?? "", MAX_COMMENT_CHARS)}`);

    const lines = [
      `## ${ctx.isPR ? "Pull request" : "Issue"} #${ctx.entityNumber}: ${entity.title}`,
      "",
      clip(entity.body ?? "(no description)", MAX_BODY_CHARS),
      ...(priorComments.length
        ? ["", "### Prior comments on this thread", "", ...priorComments]
        : []),
    ];

    return {
      trackingComment: tracking ? { id: tracking.id, body: tracking.body ?? "" } : undefined,
      context: lines.join("\n"),
    };
  } catch {
    return {};
  }
}
