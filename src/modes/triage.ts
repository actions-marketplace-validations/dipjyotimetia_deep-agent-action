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
