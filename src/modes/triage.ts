import * as core from "@actions/core";
import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Config, GitHubContext } from "../types.js";
import { resolveToken, type TokenResult } from "../github/auth.js";
import { makeOctokit } from "../github/client.js";
import { checkActorIsHuman } from "../github/validation/actor.js";
import { checkActorPermission } from "../github/validation/permissions.js";
import { findTrackingComment } from "../github/comments.js";
import { normalizeModel, resolveProviderApiKey } from "../config.js";
import { createModel } from "../agent/model.js";

/** Lifecycle states use labels as durable, visible GitHub state. */
export const TRIAGE_STATES = [
  "needs_triage",
  "needs_reproduction",
  "unable_to_reproduce",
  "unable_to_fix",
  "needs_maintainer",
  "fix_proposed",
  "not_actionable",
  "skipped",
  "failed",
] as const;
export type TriageState = (typeof TRIAGE_STATES)[number];

export interface TriageLabels {
  needsTriage: string;
  needsReproduction: string;
  unableToReproduce: string;
  unableToFix: string;
  needsMaintainer: string;
  fixProposed: string;
  notActionable: string;
  skipped: string;
  failed: string;
  /** A maintainer-applied trigger, not an authoritative lifecycle state. */
  run: string;
}

export const DEFAULT_TRIAGE_LABELS: TriageLabels = {
  needsTriage: "triage: needs triage",
  needsReproduction: "triage: needs reproduction",
  unableToReproduce: "triage: unable to reproduce",
  unableToFix: "triage: unable to fix",
  needsMaintainer: "triage: needs maintainer",
  fixProposed: "triage: fix proposed",
  notActionable: "triage: not actionable",
  skipped: "triage: skipped",
  failed: "triage: failed",
  run: "triage: run",
};

const STATE_LABEL_KEYS: Record<TriageState, keyof TriageLabels> = {
  needs_triage: "needsTriage",
  needs_reproduction: "needsReproduction",
  unable_to_reproduce: "unableToReproduce",
  unable_to_fix: "unableToFix",
  needs_maintainer: "needsMaintainer",
  fix_proposed: "fixProposed",
  not_actionable: "notActionable",
  skipped: "skipped",
  failed: "failed",
};

const RETRIAGEABLE_STATES = new Set<TriageState>([
  "needs_reproduction",
  "unable_to_reproduce",
  "unable_to_fix",
  "needs_maintainer",
  "failed",
]);

/** Return the one configured lifecycle state currently attached to an issue. */
export function currentTriageState(
  labels: string[],
  triageLabels: TriageLabels = DEFAULT_TRIAGE_LABELS,
): TriageState | null {
  for (const state of TRIAGE_STATES) {
    if (labels.includes(triageLabels[STATE_LABEL_KEYS[state]])) return state;
  }
  return null;
}

/** Calculate the minimum GitHub label mutation needed for a state transition. */
export function stateLabelSwap(
  labels: string[],
  current: TriageState | null,
  next: TriageState,
  triageLabels: TriageLabels = DEFAULT_TRIAGE_LABELS,
): { remove?: string; add: string } {
  const remove = current ? triageLabels[STATE_LABEL_KEYS[current]] : undefined;
  const add = triageLabels[STATE_LABEL_KEYS[next]];
  return labels.includes(add) ? { remove, add } : { remove, add };
}

export type TriageRoute =
  | { type: "classify" }
  | { type: "retriage"; state: TriageState }
  | { type: "run"; state: TriageState | null }
  | { type: "skip"; reason: "bot" | "pull_request" | "terminal_state" | "unmatched_event" };

/** Pure event router; all model calls and GitHub writes live outside this boundary. */
export function routeTriage(
  event: {
    eventName: string;
    eventAction?: string;
    eventLabel?: string;
    isPR: boolean;
    labels: string[];
    actor: string;
  },
  opts: { labels?: TriageLabels; botLogins?: string[] } = {},
): TriageRoute {
  const labels = opts.labels ?? DEFAULT_TRIAGE_LABELS;
  const botLogins = new Set(["github-actions[bot]", ...(opts.botLogins ?? [])].map((login) => login.toLowerCase()));
  if (event.isPR) return { type: "skip", reason: "pull_request" };
  if (botLogins.has(event.actor.toLowerCase())) return { type: "skip", reason: "bot" };

  const state = currentTriageState(event.labels, labels);
  if (event.eventName === "issues" && (event.eventAction === "opened" || event.eventAction === "reopened")) {
    return { type: "classify" };
  }
  if (event.eventName === "issues" && event.eventAction === "labeled" && event.eventLabel === labels.run) {
    return { type: "run", state };
  }
  if (event.eventName === "issue_comment" && event.eventAction === "created") {
    return state && RETRIAGEABLE_STATES.has(state)
      ? { type: "retriage", state }
      : { type: "skip", reason: state ? "terminal_state" : "unmatched_event" };
  }
  return { type: "skip", reason: "unmatched_event" };
}

export const TRIAGE_ACTIONS = ["open_pr", "review", "clarify", "label", "none"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

const TriageDecisionSchema = z.object({
  action: z.enum(TRIAGE_ACTIONS),
  /** Labels to apply, only meaningful when action is "label". */
  labels: z.array(z.string()).optional(),
  /** Clarifying comment to post, only meaningful when action is "clarify". */
  comment: z.string().optional(),
  reason: z.string(),
});

export type TriageDecision = z.infer<typeof TriageDecisionSchema>;

/** System prompt for the one-shot triage classification call (not the agentic loop). */
function buildTriageSystemPrompt(ctx: GitHubContext, allowedLabels: string[]): string {
  return [
    `You are a triage assistant for the GitHub repository ${ctx.owner}/${ctx.repo}.`,
    `You are given a new issue that did not explicitly mention the agent. Decide the single best`,
    `next action:`,
    `- "open_pr": the issue clearly describes a concrete, actionable code change, bug fix, or task`,
    `  a coding agent could implement without further clarification.`,
    `- "review": only appropriate when the issue is actually a pull request asking for a code review.`,
    `- "clarify": the request is ambiguous, underspecified, or missing information needed to act.`,
    `- "label": the issue should be labeled for triage but not acted on (e.g. duplicate, question,`,
    `  needs-info) — do not choose this to also flag something for a human, use "clarify" for that.`,
    `- "none": no action is warranted (e.g. spam, already resolved, out of scope).`,
    allowedLabels.length
      ? `When choosing "label", only choose from this allow-list: ${allowedLabels.join(", ")}.`
      : `Never choose "label" — no labels are configured for triage.`,
    `Be conservative: prefer "clarify" or "none" over "open_pr" when in doubt, since opening a PR`,
    `spends real compute and review time.`,
  ].join("\n");
}

function buildTriageUserMessage(ctx: GitHubContext): string {
  return `Issue #${ctx.entityNumber ?? "?"} title/body:\n\n${ctx.triggerText || "(no body)"}`;
}

/**
 * One-shot structured-output classification (not the full deepagents harness)
 * of a new issue with no explicit trigger phrase, deciding whether to open a
 * PR, request a review, ask for clarification, add labels, or do nothing.
 */
export async function classifyIssue(
  model: BaseChatModel,
  ctx: GitHubContext,
  opts: { allowedLabels: string[] },
): Promise<TriageDecision> {
  const structured = model.withStructuredOutput(TriageDecisionSchema);
  const result = await structured.invoke([
    { role: "system", content: buildTriageSystemPrompt(ctx, opts.allowedLabels) },
    { role: "user", content: buildTriageUserMessage(ctx) },
  ]);
  return result;
}

/**
 * What the caller should do after a triage check: hand off to the normal
 * pipeline. Carries the already-minted token so the caller reuses it instead
 * of minting (and re-authorizing) a second time.
 */
export interface TriageHandoff {
  mode: "agent" | "review";
  instruction: string;
  tokenResult: TokenResult;
}

/**
 * Entry point called from the control plane's `noop` branch for a new issue
 * with no trigger phrase. Mints its own token; only ever acts when the
 * issue's author passes the same human + write/admin permission checks as a
 * manual mention (triage never lowers the authorization bar), and only once
 * per issue (a pre-existing tracking comment means it's already been
 * triaged/acted on). "label"/"clarify"/"none" are handled here directly;
 * "open_pr"/"review" are handed back to the caller to run through the normal
 * agent/review pipeline (so approval gating, memory, and the tracking
 * comment all work exactly as they do for a manual mention) — the caller
 * reuses this function's token/auth-check/comment-lookup rather than
 * repeating them.
 */
export async function runTriageCheck(params: {
  ctx: GitHubContext;
  config: Config;
}): Promise<TriageHandoff | undefined> {
  const { ctx, config } = params;

  const tokenResult = await resolveToken({
    owner: ctx.owner,
    repo: ctx.repo,
    appId: core.getInput("app_id") || process.env.APP_ID,
    privateKey: core.getInput("app_private_key") || process.env.APP_PRIVATE_KEY,
    githubToken: core.getInput("github_token") || process.env.GITHUB_TOKEN,
  });
  const octokit = makeOctokit(tokenResult.token);

  const [human, perm] = await Promise.all([
    checkActorIsHuman(octokit, ctx.actor),
    checkActorPermission(octokit, {
      owner: ctx.owner,
      repo: ctx.repo,
      username: ctx.actor,
      allowed: config.allowedPermissions,
    }),
  ]);
  if (!human.ok || !perm.ok) {
    core.info(`Triage skipped: ${(!human.ok && human.reason) || perm.reason}`);
    return undefined;
  }

  const already = await findTrackingComment(octokit, ctx);
  if (already) {
    core.info("Triage skipped: this issue already has a tracking comment.");
    return undefined;
  }

  const apiKey = resolveProviderApiKey();
  const { provider, name } = normalizeModel(config.triageModel ?? config.model);
  const model = createModel({ provider, model: name, apiKey, baseUrl: config.baseUrl });
  const decision = await classifyIssue(model, ctx, { allowedLabels: config.triageAllowedLabels });
  core.info(`Triage decision: ${decision.action} (${decision.reason})`);

  const instruction = resolveTriageInstruction(ctx);

  switch (decision.action) {
    case "open_pr":
      return { mode: "agent", instruction, tokenResult };
    case "review":
      return ctx.isPR ? { mode: "review", instruction, tokenResult } : undefined;
    case "label": {
      const labels = filterAllowedLabels(decision, config.triageAllowedLabels);
      if (labels.length && ctx.entityNumber != null) {
        await octokit.rest.issues.addLabels({
          owner: ctx.owner,
          repo: ctx.repo,
          issue_number: ctx.entityNumber,
          labels,
        });
      }
      return undefined;
    }
    case "clarify":
      if (ctx.entityNumber != null) {
        await octokit.rest.issues.createComment({
          owner: ctx.owner,
          repo: ctx.repo,
          issue_number: ctx.entityNumber,
          body:
            decision.comment ||
            "Could you clarify this request? I couldn't tell what change to make.",
        });
      }
      return undefined;
    default:
      return undefined;
  }
}

/** Pure: which of the decision's proposed labels are within the configured allow-list. */
export function filterAllowedLabels(decision: TriageDecision, allowedLabels: string[]): string[] {
  return (decision.labels ?? []).filter((l) => allowedLabels.includes(l));
}

/** Pure: the instruction handed off to the agent/review pipeline for this issue. */
export function resolveTriageInstruction(ctx: GitHubContext): string {
  return ctx.triggerText?.trim() || "Triage and address this issue as appropriate.";
}
