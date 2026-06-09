import * as core from "@actions/core";
import { context } from "@actions/github";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, mergeRepoConfig, normalizeModel, resolveProviderApiKey } from "./config.js";
import { loadRepoConfig, type RepoConfig } from "./config/repoConfig.js";
import { parseContext } from "./github/context.js";
import { detectMode, isReviewRequest } from "./modes/detector.js";
import { resolveToken } from "./github/auth.js";
import { makeOctokit, githubServerUrl, type Octokit } from "./github/client.js";
import { forkRunAllowed } from "./github/fork.js";
import { checkActorPermission } from "./github/validation/permissions.js";
import { checkActorIsHuman } from "./github/validation/actor.js";
import { extractInstruction } from "./github/validation/trigger.js";
import {
  addEyesReaction,
  createTrackingComment,
  findTrackingComment,
  updateTrackingComment,
  renderTrackingBody,
} from "./github/comments.js";
import { createModel } from "./agent/model.js";
import { buildAgent } from "./agent/createAgent.js";
import {
  buildSystemPrompt,
  buildUserMessage,
  buildReviewSystemPrompt,
  buildReviewUserMessage,
} from "./agent/prompt.js";
import { runAgentStream } from "./agent/stream.js";
import { loadMcpTools } from "./agent/mcp.js";
import { estimateCostUsd } from "./agent/cost.js";
import { checkoutPrHead, landChanges, resolveBotIdentity } from "./github/ops.js";
import { fetchPrFiles, parseFindings, postReview, REVIEW_FINDINGS_FILE } from "./github/review.js";
import { emitOutputs } from "./outputs.js";
import type { Config, GitHubContext, Mode, RunRecord } from "./types.js";

function runUrl(ctx: GitHubContext): string {
  return `${githubServerUrl()}/${ctx.owner}/${ctx.repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
}

/** Append an optional repo-supplied system prompt to the base one. */
function systemPromptFor(base: string, repo: RepoConfig): string {
  return repo.systemPrompt ? `${base}\n\n${repo.systemPrompt}` : base;
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

/** Reuse the existing sticky tracking comment if present, else create one. */
async function getOrCreateComment(
  octokit: Octokit,
  ctx: GitHubContext,
  body: string,
): Promise<number | undefined> {
  const existing = await findTrackingComment(octokit, ctx);
  if (existing != null) {
    await updateTrackingComment(octokit, ctx, existing, body);
    return existing;
  }
  return createTrackingComment(octokit, ctx, body);
}

/**
 * Construct the model + agent from the (bundled) code paths without any network
 * calls. CI runs `DEEP_AGENT_SMOKE=1 node dist/index.js` to prove the bundle can
 * actually load the provider packages — a failure here is the dynamic-import
 * bundling bug that source-run tests cannot catch. (Importing model.ts also
 * forces every provider package to be bundled.)
 */
async function smokeCheck(): Promise<void> {
  const anthropic = createModel({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "smoke",
  });
  const openai = createModel({ provider: "openai", model: "gpt-5", apiKey: "smoke" });
  const google = createModel({ provider: "google", model: "gemini-2.5-pro", apiKey: "smoke" });
  const openrouter = createModel({
    provider: "openrouter",
    model: "openai/gpt-4o",
    apiKey: "smoke",
  });
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
    `smoke ok: ${[anthropic, openai, google, openrouter].map((m) => m.constructor.name).join(",")} stream=${typeof agent.stream}`,
  );
}

async function run(): Promise<void> {
  if (process.env.DEEP_AGENT_SMOKE === "1") {
    await smokeCheck();
    return;
  }

  const ctx = parseContext({
    eventName: context.eventName,
    actor: context.actor,
    repo: context.repo,
    payload: context.payload as Record<string, any>,
  });
  const rootDir = process.env.GITHUB_WORKSPACE || process.cwd();

  // Merge per-repo config (committed `.github/deep-agent.yml`) over action inputs.
  const repoConfig = loadRepoConfig(rootDir);
  const config = mergeRepoConfig(loadConfig(), repoConfig);

  const record: RunRecord = {
    status: "skipped",
    mode: "noop",
    model: config.model,
    plan: [],
    toolCalls: [],
    filesChanged: [],
  };

  // P0-1: route the event.
  if (detectMode(ctx, { triggerPhrase: config.triggerPhrase, prompt: config.prompt }) === "noop") {
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

  // Refine to review mode when a PR mention asks for a review.
  const mode: Mode = ctx.isPR && isReviewRequest(instruction) ? "review" : "agent";
  record.mode = mode;

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

  // P0-3: authorization — independent checks run together. Ignore bots silently.
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

  // P0-5: acknowledge + sticky tracking comment (independent calls).
  const [, commentId] = await Promise.all([
    addEyesReaction(octokit, ctx),
    getOrCreateComment(
      octokit,
      ctx,
      renderTrackingBody({ status: "working", instruction, runUrl: url }),
    ),
  ]);

  // M2: optional MCP tools (best-effort).
  const mcp = await loadMcpTools(config.mcpConfig);

  try {
    const apiKey = resolveProviderApiKey();
    const { provider, name } = normalizeModel(config.model);
    const model = createModel({ provider, model: name, apiKey, baseUrl: config.baseUrl });

    if (mode === "review") {
      await runReview({
        octokit,
        ctx,
        rootDir,
        token: tokenResult.token,
        model,
        instruction,
        repoConfig,
        config,
        record,
        commentId,
        url,
        mcpTools: mcp.tools,
      });
    } else {
      await runImplement({
        octokit,
        ctx,
        rootDir,
        token: tokenResult.token,
        appSlug: tokenResult.appSlug,
        model,
        instruction,
        repoConfig,
        config,
        record,
        commentId,
        url,
        mcpTools: mcp.tools,
      });
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
          tokens: record.tokens,
          costUsd: record.costUsd,
          error: message,
          runUrl: url,
        }),
      ).catch(() => {});
    }
    await emitOutputs(record);
    core.setFailed(`Deep Agent run failed: ${message}`);
  } finally {
    await mcp.close().catch(() => {});
  }
}

interface FlowParams {
  octokit: Octokit;
  ctx: GitHubContext;
  rootDir: string;
  model: Parameters<typeof buildAgent>[0]["model"];
  instruction: string;
  repoConfig: RepoConfig;
  config: Config;
  record: RunRecord;
  commentId: number | undefined;
  url: string;
  mcpTools: Parameters<typeof buildAgent>[0]["extraTools"];
}

/** Agent (implement) flow: edit files, then branch/PR or push (with optional approval gate). */
async function runImplement(p: FlowParams & { token: string; appSlug?: string }): Promise<void> {
  const { octokit, ctx, rootDir, model, instruction, repoConfig, config, record, commentId, url } =
    p;
  const isPRMode = ctx.isPR;

  // PR mode: switch to the PR head so the agent edits the right branch.
  if (isPRMode && ctx.prHeadRef) {
    checkoutPrHead(rootDir, p.token, ctx.owner, ctx.repo, ctx.prHeadRef);
  }

  const agent = buildAgent({
    model,
    rootDir,
    systemPrompt: systemPromptFor(buildSystemPrompt(ctx, { isPRMode }), repoConfig),
    allowedCommands: config.allowedCommands,
    deniedCommands: config.deniedCommands,
    shellTimeoutSeconds: config.shellTimeoutSeconds,
    toolCallRecord: record.toolCalls,
    extraTools: p.mcpTools,
  });

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
  applyUsage(record, config.model, result.tokens);
  record.plan = result.todos;
  record.summary = result.summary;

  // P0-7 + M4: commit + open PR / push, gated by approval when configured.
  const identity = await resolveBotIdentity(octokit, p.appSlug);
  const land = await landChanges({
    octokit,
    ctx,
    rootDir,
    token: p.token,
    isPRMode,
    instruction,
    identity,
    branchSuffix: process.env.GITHUB_RUN_ID || "run",
    requireApproval: config.requirePushApproval,
  });
  record.filesChanged = land.filesChanged;
  record.branch = land.branch;
  record.prUrl = land.prUrl;
  record.approvalPending = land.approvalPending;
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
        approvalPending: record.approvalPending,
        tokens: record.tokens,
        costUsd: record.costUsd,
        runUrl: url,
      }),
    );
  }
}

/** Review flow (M3): review the PR diff and post inline comments; no edits. */
async function runReview(p: FlowParams & { token: string }): Promise<void> {
  const { octokit, ctx, rootDir, model, instruction, repoConfig, config, record, commentId, url } =
    p;

  // Check out the PR head so the agent reads the proposed code (not the base
  // branch actions/checkout left), keeping its line numbers aligned to the diff.
  if (ctx.prHeadRef) {
    checkoutPrHead(rootDir, p.token, ctx.owner, ctx.repo, ctx.prHeadRef);
  }

  const files = await fetchPrFiles(octokit, ctx);
  const agent = buildAgent({
    model,
    rootDir,
    systemPrompt: systemPromptFor(buildReviewSystemPrompt(ctx), repoConfig),
    allowedCommands: config.allowedCommands,
    deniedCommands: config.deniedCommands,
    shellTimeoutSeconds: config.shellTimeoutSeconds,
    toolCallRecord: record.toolCalls,
    extraTools: p.mcpTools,
  });

  const result = await runAgentStream(
    agent,
    { messages: [{ role: "user", content: buildReviewUserMessage(instruction, files) }] },
    {
      threadId: `${ctx.owner}/${ctx.repo}#${ctx.entityNumber ?? "review"}`,
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
  applyUsage(record, config.model, result.tokens);
  record.plan = result.todos;

  // Read the findings the agent wrote (file-handoff), then post the review.
  const review = readFindings(rootDir, result.summary);
  await postReview(octokit, ctx, review);
  record.summary = `Reviewed ${files.length} file(s); posted ${review.findings.length} inline comment(s).`;
  record.status = "success";

  if (commentId != null) {
    await updateTrackingComment(
      octokit,
      ctx,
      commentId,
      renderTrackingBody({
        status: "success",
        instruction,
        summary: `${record.summary}\n\n${review.summary}`,
        tokens: record.tokens,
        costUsd: record.costUsd,
        runUrl: url,
      }),
    );
  }
}

/** Read the agent-written review findings file; fall back to a summary-only review. */
function readFindings(rootDir: string, fallbackSummary: string) {
  const path = join(rootDir, REVIEW_FINDINGS_FILE);
  if (existsSync(path)) {
    try {
      const parsed = parseFindings(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.summary) parsed.summary = fallbackSummary;
      return parsed;
    } catch {
      // Fall through to summary-only.
    }
  }
  return { summary: fallbackSummary, findings: [] };
}

/** Record token usage + estimated cost on the run record. */
function applyUsage(
  record: RunRecord,
  model: string,
  tokens: { input: number; output: number },
): void {
  record.tokens = tokens;
  record.costUsd = estimateCostUsd(model, tokens);
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
    await getOrCreateComment(
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
