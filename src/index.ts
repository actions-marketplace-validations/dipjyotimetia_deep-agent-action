import * as core from "@actions/core";
import { context } from "@actions/github";

import { loadConfig, normalizeModel, resolveProviderApiKey } from "./config.js";
import { parseContext } from "./github/context.js";
import { detectMode } from "./modes/detector.js";
import { resolveToken } from "./github/auth.js";
import { makeOctokit, githubServerUrl, type Octokit } from "./github/client.js";
import { forkRunAllowed } from "./github/fork.js";
import { checkActorPermission } from "./github/validation/permissions.js";
import { checkActorIsHuman } from "./github/validation/actor.js";
import { extractInstruction } from "./github/validation/trigger.js";
import {
  addEyesReaction,
  createTrackingComment,
  updateTrackingComment,
  renderTrackingBody,
} from "./github/comments.js";
import { createModel } from "./agent/model.js";
import { buildAgent } from "./agent/createAgent.js";
import { buildSystemPrompt, buildUserMessage } from "./agent/prompt.js";
import { runAgentStream } from "./agent/stream.js";
import { checkoutPrHead, landChanges, resolveBotIdentity } from "./github/ops.js";
import { emitOutputs } from "./outputs.js";
import type { GitHubContext, RunRecord } from "./types.js";

function runUrl(ctx: GitHubContext): string {
  return `${githubServerUrl()}/${ctx.owner}/${ctx.repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
}

/** When the event is a PR comment, the payload lacks head/base repo info; fetch it. */
async function resolvePrRefs(octokit: Octokit, ctx: GitHubContext): Promise<void> {
  if (!ctx.isPR || ctx.entityNumber == null || ctx.prHeadRepoFullName) return;
  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.entityNumber,
    });
    ctx.prHeadRepoFullName = pr.head.repo?.full_name ?? undefined;
    ctx.prBaseRepoFullName = pr.base.repo?.full_name ?? undefined;
    ctx.prHeadRef = pr.head.ref;
  } catch {
    // Leave fork status undetermined; fork gating treats PRs as untrusted then.
  }
}

/**
 * Construct the model + agent from the (bundled) code paths without any network
 * calls. CI runs `DEEP_AGENT_SMOKE=1 node dist/index.js` to prove the bundle can
 * actually load the provider packages — a failure here is the dynamic-import
 * bundling bug that source-run tests cannot catch.
 */
async function smokeCheck(): Promise<void> {
  const anthropic = createModel({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "smoke",
  });
  const openai = createModel({ provider: "openai", model: "gpt-5", apiKey: "smoke" });
  const agent = buildAgent({
    model: anthropic,
    rootDir: process.cwd(),
    systemPrompt: "smoke",
    allowedCommands: ["echo"],
    deniedCommands: [],
    shellTimeoutSeconds: 5,
    toolCallRecord: [],
  });
  core.info(
    `smoke ok: anthropic=${anthropic.constructor.name} openai=${openai.constructor.name} stream=${typeof agent.stream}`,
  );
}

async function run(): Promise<void> {
  if (process.env.DEEP_AGENT_SMOKE === "1") {
    await smokeCheck();
    return;
  }

  const config = loadConfig();
  const ctx = parseContext({
    eventName: context.eventName,
    actor: context.actor,
    repo: context.repo,
    payload: context.payload as Record<string, any>,
  });

  const record: RunRecord = {
    status: "skipped",
    mode: "noop",
    model: config.model,
    plan: [],
    toolCalls: [],
    filesChanged: [],
  };

  // P0-1: route the event.
  const mode = detectMode(ctx, { triggerPhrase: config.triggerPhrase, prompt: config.prompt });
  record.mode = mode;
  if (mode === "noop") {
    core.info("No trigger phrase / prompt for this event; exiting with no side effects.");
    await emitOutputs(record);
    return;
  }

  // P0-2: resolve the instruction.
  const instruction =
    config.prompt?.trim() || extractInstruction(ctx.triggerText, config.triggerPhrase);
  record.instruction = instruction;
  if (!instruction) {
    core.info("Trigger matched but no instruction text was provided; exiting.");
    await emitOutputs(record);
    return;
  }

  // P0-12: mint a scoped, short-lived token.
  const tokenResult = await resolveToken({
    owner: ctx.owner,
    repo: ctx.repo,
    appId: core.getInput("app_id") || process.env.APP_ID,
    privateKey: core.getInput("app_private_key") || process.env.APP_PRIVATE_KEY,
    githubToken: core.getInput("github_token") || process.env.GITHUB_TOKEN,
  });
  const octokit = makeOctokit(tokenResult.token);

  await resolvePrRefs(octokit, ctx);

  // P0-4: fork-PR secret protection (before any agent execution).
  const fork = forkRunAllowed(ctx, config.forkAllowLabel);
  if (!fork.allowed) {
    await refuse(octokit, ctx, record, fork.reason!);
    return;
  }

  // P0-3: authorization — the two checks are independent, so run them together.
  // Ignore bots silently (no loops); refuse under-privileged actors with a comment.
  const [human, perm] = await Promise.all([
    checkActorIsHuman(octokit, ctx.actor),
    checkActorPermission(octokit, {
      owner: ctx.owner,
      repo: ctx.repo,
      username: ctx.actor,
      allowed: config.allowedPermissions,
    }),
  ]);
  if (!human.ok) {
    core.info(`Ignoring non-human actor: ${human.reason}`);
    record.status = "refused";
    await emitOutputs(record);
    return;
  }
  if (!perm.ok) {
    await refuse(octokit, ctx, record, perm.reason!);
    return;
  }

  const url = runUrl(ctx);
  const rootDir = process.env.GITHUB_WORKSPACE || process.cwd();

  // P0-5: acknowledge + create the tracking comment (independent calls).
  const [, commentId] = await Promise.all([
    addEyesReaction(octokit, ctx),
    createTrackingComment(
      octokit,
      ctx,
      renderTrackingBody({ status: "working", instruction, runUrl: url }),
    ),
  ]);

  const isPRMode = ctx.isPR;

  try {
    // PR mode: switch to the PR head so the agent edits the right branch.
    if (isPRMode && ctx.prHeadRef) {
      checkoutPrHead(rootDir, tokenResult.token, ctx.owner, ctx.repo, ctx.prHeadRef);
    }

    // P0-6/P0-8/P0-13: build the in-runner agent.
    const apiKey = resolveProviderApiKey();
    const { provider, name } = normalizeModel(config.model);
    const model = createModel({ provider, model: name, apiKey });
    const agent = buildAgent({
      model,
      rootDir,
      systemPrompt: buildSystemPrompt(ctx, { isPRMode }),
      allowedCommands: config.allowedCommands,
      deniedCommands: config.deniedCommands,
      shellTimeoutSeconds: config.shellTimeoutSeconds,
      toolCallRecord: record.toolCalls,
    });

    // P0-9: stream and mirror progress.
    const result = await runAgentStream(
      agent,
      { messages: [{ role: "user", content: buildUserMessage(instruction, ctx) }] },
      {
        threadId: `${ctx.owner}/${ctx.repo}#${ctx.entityNumber ?? "dispatch"}`,
        debounceMs: config.commentDebounceMs,
        onProgress: async (todos) => {
          if (commentId != null) {
            await updateTrackingComment(
              octokit,
              ctx,
              commentId,
              renderTrackingBody({ status: "working", instruction, todos, runUrl: url }),
            );
          }
        },
      },
    );
    record.plan = result.todos;
    record.summary = result.summary;

    // P0-7: commit + open PR (or push to the existing PR branch).
    const identity = await resolveBotIdentity(octokit, tokenResult.appSlug);
    const land = await landChanges({
      octokit,
      ctx,
      rootDir,
      token: tokenResult.token,
      isPRMode,
      instruction,
      identity,
      branchSuffix: process.env.GITHUB_RUN_ID || "run",
    });
    record.filesChanged = land.filesChanged;
    record.branch = land.branch;
    record.prUrl = land.prUrl;
    record.status = "success";

    if (commentId != null) {
      await updateTrackingComment(
        octokit,
        ctx,
        commentId,
        renderTrackingBody({
          status: "success",
          instruction,
          todos: record.plan,
          summary: record.summary,
          prUrl: record.prUrl,
          branch: record.branch,
          runUrl: url,
        }),
      );
    }
    await emitOutputs(record);
  } catch (err) {
    // P0-11: clean failure with an actionable comment.
    const message = err instanceof Error ? err.message : String(err);
    record.status = "failed";
    record.error = message;
    if (commentId != null) {
      await updateTrackingComment(
        octokit,
        ctx,
        commentId,
        renderTrackingBody({
          status: "failed",
          instruction,
          todos: record.plan,
          summary: record.summary,
          error: message,
          runUrl: url,
        }),
      ).catch(() => {});
    }
    await emitOutputs(record);
    core.setFailed(`Deep Agent run failed: ${message}`);
  }
}

/** Post a refusal comment (when possible), set status, emit outputs, and exit cleanly. */
async function refuse(
  octokit: Octokit,
  ctx: GitHubContext,
  record: RunRecord,
  reason: string,
): Promise<void> {
  record.status = "refused";
  record.error = reason;
  core.warning(reason);
  if (ctx.entityNumber != null) {
    await createTrackingComment(
      octokit,
      ctx,
      renderTrackingBody({ status: "refused", error: reason }),
    ).catch(() => {});
  }
  await emitOutputs(record);
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(`Deep Agent action crashed: ${message}`);
});
