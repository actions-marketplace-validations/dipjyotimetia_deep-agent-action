import { z } from "zod";
import type { context } from "@actions/github";
import type { GitHubContext } from "../types.js";

/** The webhook event payload, as typed by @actions/github's context. */
type WebhookPayload = (typeof context)["payload"];

/** Minimal shape of the @actions/github context we consume. Kept narrow for testability. */
export interface RawContext {
  eventName: string;
  actor: string;
  repo: { owner: string; repo: string };
  payload: WebhookPayload;
}

/**
 * Permissive schema for just the slice of the webhook payload we read. Every
 * field is optional and `.catch`ed so a malformed branch degrades to `undefined`
 * instead of collapsing the whole parse (this feeds gating, so resilience
 * matters). `looseObject` keeps unrecognized keys.
 */
const LabelSchema = z.union([z.string(), z.looseObject({ name: z.string().optional() })]);
const RepoRefSchema = z.looseObject({ full_name: z.string().optional() });
const PrRefSchema = z.looseObject({
  ref: z.string().optional(),
  repo: RepoRefSchema.optional().catch(undefined),
});
const PullRequestSchema = z.looseObject({
  number: z.number().optional().catch(undefined),
  title: z.string().optional().catch(undefined),
  body: z.string().optional().catch(undefined),
  labels: z.array(LabelSchema).optional().catch(undefined),
  head: PrRefSchema.optional().catch(undefined),
  base: PrRefSchema.optional().catch(undefined),
});
const IssueSchema = z.looseObject({
  number: z.number().optional().catch(undefined),
  title: z.string().optional().catch(undefined),
  body: z.string().optional().catch(undefined),
  labels: z.array(LabelSchema).optional().catch(undefined),
  pull_request: z.unknown().optional(),
});
const PayloadSchema = z.looseObject({
  action: z.string().optional().catch(undefined),
  issue: IssueSchema.optional().catch(undefined),
  pull_request: PullRequestSchema.optional().catch(undefined),
  comment: z
    .looseObject({
      id: z.number().optional().catch(undefined),
      body: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/**
 * Normalize the raw GitHub Actions context + webhook payload into our typed view.
 * Pure function — pass a RawContext so it can be unit-tested without the runner.
 */
export function parseContext(raw: RawContext): GitHubContext {
  const { eventName } = raw;
  const payload = PayloadSchema.safeParse(raw.payload).data ?? {};
  const eventAction = payload.action;

  const issue = payload.issue;
  const pr = payload.pull_request;
  const comment = payload.comment;

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
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter((name): name is string => Boolean(name));

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
    labels,
    payload: raw.payload,
  };
}
