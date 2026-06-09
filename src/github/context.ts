import type { GitHubContext } from "../types.js";

/** Minimal shape of the @actions/github context we consume. Kept narrow for testability. */
export interface RawContext {
  eventName: string;
  actor: string;
  repo: { owner: string; repo: string };
  payload: Record<string, any>;
}

/**
 * Normalize the raw GitHub Actions context + webhook payload into our typed view.
 * Pure function — pass a RawContext so it can be unit-tested without the runner.
 */
export function parseContext(raw: RawContext): GitHubContext {
  const { eventName, payload } = raw;
  const eventAction: string | undefined = payload?.action;

  const issue = payload?.issue;
  const pr = payload?.pull_request;
  const comment = payload?.comment;

  // Is this event attached to a pull request?
  const isPR =
    Boolean(pr) || Boolean(issue?.pull_request) || eventName === "pull_request_review_comment";

  const entityNumber: number | undefined = pr?.number ?? issue?.number;

  // Body that may carry the trigger phrase, by event.
  let triggerText: string | undefined;
  if (comment?.body) triggerText = comment.body;
  else if (eventName === "issues")
    triggerText = [issue?.title, issue?.body].filter(Boolean).join("\n\n");
  else if (eventName === "pull_request")
    triggerText = [pr?.title, pr?.body].filter(Boolean).join("\n\n");

  const isPullRequestReviewComment = eventName === "pull_request_review_comment";

  const labels: string[] = (issue?.labels ?? pr?.labels ?? [])
    .map((l: any) => (typeof l === "string" ? l : l?.name))
    .filter(Boolean);

  return {
    eventName,
    eventAction,
    owner: raw.repo.owner,
    repo: raw.repo.repo,
    actor: raw.actor,
    entityNumber,
    isPR,
    triggerText,
    commentId: comment?.id,
    isPullRequestReviewComment,
    prHeadRepoFullName: pr?.head?.repo?.full_name,
    prBaseRepoFullName: pr?.base?.repo?.full_name,
    prHeadRef: pr?.head?.ref,
    prBaseRef: pr?.base?.ref,
    labels,
    payload,
  };
}
