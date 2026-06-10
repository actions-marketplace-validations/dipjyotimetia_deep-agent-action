/**
 * Build a synthetic `issue_comment` webhook payload that the action parses as a
 * review request on a pull request.
 *
 * Review mode requires a PR-attached event (`ctx.isPR`), which `workflow_dispatch`
 * cannot produce. The live E2E review job opens a throwaway PR, writes this event
 * to a file, and points `GITHUB_EVENT_PATH` at it — the action then does the real
 * work (fetch PR head, run the model, post an inline review) against that PR.
 *
 * CLI:  bun run scripts/e2e/build-review-event.ts [outPath]
 *       env: PR_NUMBER (required), COMMENT_BODY (default "@agent review"), COMMENT_ID
 */
import { writeFileSync } from "node:fs";

export interface ReviewEvent {
  action: "created";
  issue: {
    number: number;
    /** Presence of `pull_request` is what marks the issue_comment as PR-attached. */
    pull_request: { url: string };
  };
  comment: { id: number; body: string };
}

export function buildReviewEvent(opts: {
  prNumber: number | string;
  commentBody?: string;
  commentId?: number | string;
}): ReviewEvent {
  if (opts.prNumber == null || opts.prNumber === "") {
    throw new Error("buildReviewEvent: prNumber is required");
  }
  const number = Number(opts.prNumber);
  return {
    action: "created",
    issue: {
      number,
      pull_request: { url: `https://api.github.com/repos/_/_/pulls/${number}` },
    },
    comment: { id: Number(opts.commentId ?? 1), body: opts.commentBody || "@agent review" },
  };
}

if (import.meta.main) {
  const event = buildReviewEvent({
    prNumber: process.env.PR_NUMBER ?? "",
    commentBody: process.env.COMMENT_BODY,
    commentId: process.env.COMMENT_ID,
  });
  const json = JSON.stringify(event, null, 2);
  const out = process.argv[2];
  if (out) {
    writeFileSync(out, json);
    console.error(`wrote review event for PR #${event.issue.number} -> ${out}`);
  } else {
    console.log(json);
  }
}
