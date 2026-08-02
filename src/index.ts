import * as core from "@actions/core";
import { context } from "@actions/github";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, mergeRepoConfig, normalizeModel, resolveProviderApiKey } from "./config.js";
import { loadRepoConfig, type RepoConfig } from "./config/repoConfig.js";
import { parseContext } from "./github/context.js";
import {
  detectMode,
  isReviewRequest,
  isReviewAndFixRequest,
  isResumeRequest,
} from "./modes/detector.js";
import { runTriageCheck, type TriageHandoff } from "./modes/triage.js";
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
  type TrackingState,
} from "./github/comments.js";
import { fetchThread, type ThreadInfo } from "./github/thread.js";
import { parseMemory, appendTurn, buildMemoryContext, type MemoryTurn } from "./github/memory.js";
import { createModel } from "./agent/model.js";
import { buildAgent, type BuildAgentOptions } from "./agent/createAgent.js";
import {
  buildSystemPrompt,
  buildUserMessage,
  buildReviewSystemPrompt,
  buildReviewUserMessage,
} from "./agent/prompt.js";
import {
  runAgentStream,
  type StreamActivity,
  type TodoItem,
  type BudgetOptions,
} from "./agent/stream.js";
import { loadMcpTools } from "./agent/mcp.js";
import { estimateCostUsd } from "./agent/cost.js";
import {
  checkoutPrHead,
  checkoutIssueBranchIfExists,
  buildRunBranchSuffix,
  generateBranchName,
  getCurrentBranch,
  landChanges,
  resolveBotIdentity,
  type LandResult,
} from "./github/ops.js";
import { landChangesVerified } from "./github/graphqlCommit.js";
import {
  applyReviewSuggestions,
  fetchPrFiles,
  parseFindings,
  postReview,
  REVIEW_FINDINGS_FILE,
} from "./github/review.js";
import { buildFailureRecord, emitOutputs } from "./outputs.js";
import type { Config, GitHubContext, Mode, RunRecord, TokenUsage } from "./types.js";

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
  return upsertComment(octokit, ctx, existing?.id, body);
}

/** Update the tracking comment by id when known, else create it. */
async function upsertComment(
  octokit: Octokit,
  ctx: GitHubContext,
  existingId: number | undefined,
  body: string,
): Promise<number | undefined> {
  if (existingId != null) {
    await updateTrackingComment(octokit, ctx, existingId, body);
    return existingId;
  }
  return createTrackingComment(octokit, ctx, body);
}

/** Build the budget ceiling for the agent stream, or undefined when uncapped. */
function budgetFrom(config: Config): BudgetOptions | undefined {
  if (config.maxCostUsd == null && config.maxTotalTokens == null) return undefined;
  return {
    model: config.model,
    maxCostUsd: config.maxCostUsd,
    maxTotalTokens: config.maxTotalTokens,
  };
}

/** The run-level wall-clock cap in milliseconds, or undefined when uncapped. */
function maxRuntimeMsFrom(config: Config): number | undefined {
  return config.maxRuntimeMinutes != null ? config.maxRuntimeMinutes * 60_000 : undefined;
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
    model: "claude-sonnet-4-6",
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
    mode: "implement",
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
    payload: context.payload,
  });
  const rootDir = process.env.GITHUB_WORKSPACE || process.cwd();

  // Merge per-repo config (committed `.github/deep-agent.yml`) over action inputs.
  const repoConfig = loadRepoConfig(rootDir);
  let config = mergeRepoConfig(loadConfig(), repoConfig);

  const record: RunRecord = {
    status: "skipped",
    mode: "noop",
    model: config.model,
    plan: [],
    toolCalls: [],
    filesChanged: [],
  };

  // P0-1: route the event.
  const modeDetected = detectMode(ctx, {
    triggerPhrase: config.triggerPhrase,
    prompt: config.prompt,
    autoRunLabel: config.autoRunLabel,
    autoRunAssignee: config.autoRunAssignee,
  });
  // A new issue with no trigger phrase is otherwise a silent no-op; when
  // enabled, triage gets one shot at classifying it (open a PR, request a
  // review, ask for clarification, add labels) before we give up on it.
  // Explicit triggers (trigger phrase, auto_run_label/assignee) always win —
  // triage only ever runs when nothing else already matched.
  let triageHandoff: TriageHandoff | undefined;
  if (
    modeDetected === "noop" &&
    config.enableTriage &&
    ctx.eventName === "issues" &&
    ctx.eventAction === "opened"
  ) {
    triageHandoff = await runTriageCheck({ ctx, config });
  }

  if (modeDetected === "noop" && !triageHandoff) {
    core.info("No trigger phrase / prompt for this event; exiting with no side effects.");
    await emitOutputs(record);
    return;
  }

  // A triage-originated run always lands behind the approval gate (draft PR /
  // proposed branch) regardless of the repo's require_push_approval setting —
  // a misclassification should never push/merge unsupervised.
  if (triageHandoff) config = { ...config, requirePushApproval: true };

  // An auto-run label/assignee bypasses the trigger phrase, so the issue may have
  // no phrase to extract an instruction after — fall back to the whole triggerText
  // (already extracted by extractInstruction when the phrase is absent), and if
  // that's still empty, a configurable default instruction.
  const isAutoRun =
    ctx.eventName === "issues" &&
    ((config.autoRunLabel && ctx.eventLabel === config.autoRunLabel) ||
      (config.autoRunAssignee && ctx.eventAssignee === config.autoRunAssignee));

  // P0-2: resolve the instruction.
  const instruction =
    triageHandoff?.instruction ||
    config.prompt?.trim() ||
    extractInstruction(ctx.triggerText, config.triggerPhrase) ||
    (isAutoRun ? (config.autoRunDefaultInstruction ?? "") : "");
  record.instruction = instruction;
  if (!instruction) {
    core.info("Trigger matched but no instruction text was provided; exiting.");
    await emitOutputs(record);
    return;
  }

  // Refine to review mode when a PR mention asks for a review (or triage
  // decided this issue is actually a PR asking for one). "review and fix"
  // (or the apply_suggestions config) additionally applies the review's own
  // single-line suggestions and lands them as a commit.
  const mode: Mode =
    triageHandoff?.mode === "review" || (ctx.isPR && isReviewRequest(instruction))
      ? "review"
      : "agent";
  record.mode = mode;
  const applyFixes =
    mode === "review" && (isReviewAndFixRequest(instruction) || config.applySuggestions);

  // P0-12: mint a scoped, short-lived token — reuse triage's if it already
  // minted one (it already ran the same auth checks below for this actor).
  const tokenResult =
    triageHandoff?.tokenResult ??
    (await resolveToken({
      owner: ctx.owner,
      repo: ctx.repo,
      appId: core.getInput("app_id") || process.env.APP_ID,
      privateKey: core.getInput("app_private_key") || process.env.APP_PRIVATE_KEY,
      githubToken: core.getInput("github_token") || process.env.GITHUB_TOKEN,
    }));
  const octokit = makeOctokit(tokenResult.token);

  await resolvePrRefs(octokit, ctx);

  // P0-4: fork-PR secret protection (before any agent execution).
  const fork = forkRunAllowed(ctx, config.forkAllowLabel);
  if (!fork.allowed) {
    await refuse(octokit, ctx, record, fork.reason!);
    return;
  }

  // P0-3: authorization — independent checks run together. Ignore bots
  // silently. Skipped for a triage handoff: runTriageCheck already verified
  // this exact actor/repo pass the same checks moments ago.
  if (!triageHandoff) {
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
  }

  const url = runUrl(ctx);
  const branchSuffix = buildRunBranchSuffix();

  // P0-5 + M2: acknowledge, find the existing tracking comment, and load any MCP
  // tools — all independent, so run them together. We find (not yet upsert) the
  // comment first so prior thread memory is read before we overwrite it. A
  // triage handoff is guaranteed to have none yet (runTriageCheck only hands
  // off when its own lookup found none), so skip re-fetching it.
  const [, thread, mcp] = await Promise.all([
    addEyesReaction(octokit, ctx),
    triageHandoff ? Promise.resolve<ThreadInfo>({}) : fetchThread(octokit, ctx),
    loadMcpTools(config.mcpConfig),
  ]);
  const existingComment = thread.trackingComment;
  const threadContext = thread.context;

  // Cross-run memory: parse the prior turns once, then route the working,
  // progress, success, and failure renders through a closure that re-embeds the
  // memory block by default. Only the final success render overrides `memory`
  // (to append the new turn). (The pre-authorization `refuse()` path renders
  // before this point and intentionally does not preserve memory.)
  const priorMemory = parseMemory(existingComment?.body);
  const renderBody = (state: TrackingState): string =>
    renderTrackingBody({ ...state, memory: state.memory ?? priorMemory });

  const commentId = await upsertComment(
    octokit,
    ctx,
    existingComment?.id,
    renderBody({ status: "working", instruction, runUrl: url }),
  );

  try {
    const apiKey = resolveProviderApiKey();
    const modelFor = (modelSpec: string) => {
      const { provider, name } = normalizeModel(modelSpec);
      return createModel({ provider, model: name, apiKey, baseUrl: config.baseUrl });
    };
    const model = modelFor(config.model);

    if (mode === "review") {
      await runReview({
        octokit,
        ctx,
        rootDir,
        token: tokenResult.token,
        tokenSource: tokenResult.source,
        appSlug: tokenResult.appSlug,
        applyFixes,
        model,
        modelFor,
        instruction,
        repoConfig,
        config,
        record,
        commentId,
        url,
        branchSuffix,
        mcpTools: mcp.tools,
        renderBody,
        priorMemory,
        threadContext,
      });
    } else {
      await runImplement({
        octokit,
        ctx,
        rootDir,
        token: tokenResult.token,
        tokenSource: tokenResult.source,
        appSlug: tokenResult.appSlug,
        model,
        modelFor,
        instruction,
        repoConfig,
        config,
        record,
        commentId,
        url,
        branchSuffix,
        mcpTools: mcp.tools,
        renderBody,
        priorMemory,
        threadContext,
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
        renderBody({
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
  token: string;
  tokenSource: "app" | "github_token";
  model: Parameters<typeof buildAgent>[0]["model"];
  /** Static-provider model factory for configured specialist overrides. */
  modelFor: (modelSpec: string) => Parameters<typeof buildAgent>[0]["model"];
  instruction: string;
  repoConfig: RepoConfig;
  config: Config;
  record: RunRecord;
  commentId: number | undefined;
  url: string;
  mcpTools: Extract<BuildAgentOptions, { mode: "implement" }>["extraTools"];
  /** Renders a tracking-comment body, re-embedding the thread memory block. */
  renderBody: (state: TrackingState) => string;
  /** Prior turns on this thread, fed back as context and appended to on success. */
  priorMemory: MemoryTurn[];
  /** Issue/PR title, description, and prior human comments, rendered for the agent's prompt. */
  threadContext?: string;
  /** Suffix used for run-scoped branch names (e.g. a bare dispatch, or a proposed-branch run). */
  branchSuffix: string;
  /** The GitHub App slug, when authenticated via an App (used for commit identity). */
  appSlug?: string;
}

/** The progress-mirror callback shared by both flows: reflect the plan into the tracking comment. */
function mirrorProgress(p: FlowParams): (todos: TodoItem[]) => Promise<void> {
  return async (todos) => {
    p.record.plan = todos;
    if (p.commentId != null) {
      await updateTrackingComment(
        p.octokit,
        p.ctx,
        p.commentId,
        p.renderBody({ status: "working", instruction: p.instruction, todos, runUrl: p.url }),
      );
    }
  };
}

/** Record typed activity and occasionally mirror the latest event to GitHub. */
function mirrorActivity(p: FlowParams): (activity: StreamActivity) => Promise<void> {
  let lastMirrorAt = 0;
  return async (activity) => {
    p.record.activities ??= [];
    p.record.activities.push(activity);
    const now = Date.now();
    if (p.commentId == null || now - lastMirrorAt < p.config.commentDebounceMs) return;
    lastMirrorAt = now;
    await updateTrackingComment(
      p.octokit,
      p.ctx,
      p.commentId,
      p.renderBody({
        status: "working",
        instruction: p.instruction,
        todos: p.record.plan,
        activity,
        runUrl: p.url,
      }),
    );
  };
}

/** Fail fast, before any expensive work, when verified_commits can't be honored. */
function assertVerifiedCommitsAuth(config: Config, tokenSource: "app" | "github_token"): void {
  if (config.verifiedCommits && tokenSource !== "app") {
    throw new Error(
      "verified_commits is enabled but no GitHub App auth is configured (app_id + app_private_key); " +
        "refusing to fall back to unsigned commits.",
    );
  }
}

/** Land the working tree's changes via the verified (GraphQL) or plain-git path, per config. */
async function landChangesForRun(
  p: FlowParams,
  args: {
    isPRMode: boolean;
    instruction: string;
    branchSuffix: string;
    requireApproval: boolean;
    continuingBranch?: boolean;
    baseBranch?: string;
  },
): Promise<LandResult> {
  if (p.config.verifiedCommits) {
    return landChangesVerified({ octokit: p.octokit, ctx: p.ctx, rootDir: p.rootDir, ...args });
  }
  const identity = await resolveBotIdentity(p.octokit, p.appSlug);
  return landChanges({
    octokit: p.octokit,
    ctx: p.ctx,
    rootDir: p.rootDir,
    token: p.token,
    identity,
    ...args,
  });
}

/** Agent (implement) flow: edit files, then branch/PR or push (with optional approval gate). */
async function runImplement(p: FlowParams): Promise<void> {
  const {
    octokit,
    ctx,
    rootDir,
    model,
    instruction,
    repoConfig,
    config,
    record,
    commentId,
    url,
    branchSuffix,
  } = p;
  const isPRMode = ctx.isPR;

  // Fail fast (before spending an agent run) rather than silently falling
  // back to unsigned commits when verified_commits is requested without App auth.
  assertVerifiedCommitsAuth(config, p.tokenSource);

  // PR mode: switch to the PR head so the agent edits the right branch.
  if (isPRMode && ctx.prHeadRef) {
    checkoutPrHead(rootDir, p.token, ctx.owner, ctx.repo, ctx.prHeadRef);
  }

  // Issue/dispatch mode: capture the true default branch before any checkout,
  // then continue on the issue's existing deep-agent branch if a prior
  // mention already created one, so this run extends the same branch/PR
  // instead of opening a new one.
  let baseBranch: string | undefined;
  let continuingBranch = false;
  if (!isPRMode) {
    baseBranch = getCurrentBranch(rootDir);
    if (ctx.entityNumber != null) {
      const branch = generateBranchName(ctx, branchSuffix);
      continuingBranch = checkoutIssueBranchIfExists(rootDir, p.token, ctx.owner, ctx.repo, branch);
    }
  }

  const agent = buildAgent({
    model,
    modelSpec: config.model,
    rootDir,
    mode: "implement",
    systemPrompt: systemPromptFor(buildSystemPrompt(ctx, { isPRMode }), repoConfig),
    harnessProfile: config.harnessProfile,
    filesystemPermissions: config.filesystemPermissions,
    interruptOn: config.interruptOn,
    allowedCommands: config.allowedCommands,
    deniedCommands: config.deniedCommands,
    shellTimeoutSeconds: config.shellTimeoutSeconds,
    toolCallRecord: record.toolCalls,
    extraTools: p.mcpTools,
    subagents: config.subagents,
    subagentModelFor: p.modelFor,
  });

  // "continue"/"resume" seeds the prior turn's incomplete todo list directly
  // into the agent's initial state (the deepagents harness accepts `todos` as
  // part of the input), so the plan picks up where it left off instead of
  // starting over.
  const resume = isResumeRequest(instruction);
  const resumeTodos = resume ? p.priorMemory.at(-1)?.openTodos : undefined;

  const result = await runAgentStream(
    agent,
    {
      messages: [
        {
          role: "user",
          content: buildUserMessage(
            instruction,
            ctx,
            buildMemoryContext(p.priorMemory, { resume }),
            p.threadContext,
          ),
        },
      ],
      ...(resumeTodos?.length ? { todos: resumeTodos } : {}),
    },
    {
      threadId: `${ctx.owner}/${ctx.repo}#${ctx.entityNumber ?? "dispatch"}`,
      debounceMs: config.commentDebounceMs,
      onProgress: mirrorProgress(p),
      onActivity: mirrorActivity(p),
      budget: budgetFrom(config),
      maxRuntimeMs: maxRuntimeMsFrom(config),
      recursionLimit: config.recursionLimit,
      maxRepeatedToolCalls: config.maxRepeatedToolCalls,
    },
  );
  applyUsage(record, config.model, result.tokens);
  record.plan = result.todos;
  record.summary = result.summary;
  record.stopReason = result.stopped;
  record.stopDetail = result.stopDetail;
  record.pendingInterrupts = result.pendingInterrupts;
  record.activities = result.activities;

  // P0-7 + M4: commit + open PR / push, gated by approval when configured. A
  // budget or runtime stop forces the approval path so partial work lands as a
  // draft for review rather than directly on a branch.
  const requireApproval = config.requirePushApproval || record.stopReason != null;
  const land = await landChangesForRun(p, {
    isPRMode,
    instruction,
    branchSuffix,
    requireApproval,
    continuingBranch,
    baseBranch,
  });
  record.filesChanged = land.filesChanged;
  record.branch = land.branch;
  record.prUrl = land.prUrl;
  record.approvalPending = land.approvalPending;
  record.status = result.stopped === "interrupt" ? "interrupted" : "success";

  if (commentId != null) {
    await updateTrackingComment(
      octokit,
      ctx,
      commentId,
      p.renderBody({
        status: record.status,
        instruction,
        todos: record.plan,
        summary: record.summary,
        prUrl: record.prUrl,
        branch: record.branch,
        approvalPending: record.approvalPending,
        stopReason: record.stopReason,
        stopDetail: record.stopDetail,
        interrupts: record.pendingInterrupts,
        activity: record.activities?.at(-1),
        tokens: record.tokens,
        costUsd: record.costUsd,
        runUrl: url,
        memory: appendTurn(p.priorMemory, {
          instruction,
          summary: record.summary ?? "",
          prUrl: record.prUrl,
          openTodos: record.plan,
        }),
      }),
    );
  }
}

/**
 * Review flow (M3): review the PR diff and post inline comments; no edits.
 * When `applyFixes` is set (a "review and fix" mention, or `apply_suggestions`
 * configured repo-wide), findings with a clean single-line `suggestion` are
 * also applied directly to the files and landed as a commit before the
 * review is posted — findings without one still surface as comments.
 */
async function runReview(p: FlowParams & { applyFixes: boolean }): Promise<void> {
  const { octokit, ctx, rootDir, model, instruction, repoConfig, config, record, commentId, url } =
    p;

  if (p.applyFixes) {
    assertVerifiedCommitsAuth(config, p.tokenSource);
  }

  // Check out the PR head so the agent reads the proposed code (not the base
  // branch actions/checkout left), keeping its line numbers aligned to the diff.
  if (ctx.prHeadRef) {
    checkoutPrHead(rootDir, p.token, ctx.owner, ctx.repo, ctx.prHeadRef);
  }

  const files = await fetchPrFiles(octokit, ctx);
  const reviewOutputDir = mkdtempSync(join(tmpdir(), "deep-agent-review-"));
  let result;
  try {
    const agent = buildAgent({
      model,
      modelSpec: config.model,
      rootDir,
      mode: "review",
      reviewOutputDir,
      systemPrompt: systemPromptFor(buildReviewSystemPrompt(ctx), repoConfig),
      harnessProfile: config.harnessProfile,
      filesystemPermissions: config.filesystemPermissions,
      interruptOn: config.interruptOn,
      allowedCommands: config.allowedCommands,
      deniedCommands: config.deniedCommands,
      shellTimeoutSeconds: config.shellTimeoutSeconds,
      toolCallRecord: record.toolCalls,
    });

    result = await runAgentStream(
      agent,
      {
        messages: [
          {
            role: "user",
            content: buildReviewUserMessage(
              instruction,
              files,
              buildMemoryContext(p.priorMemory),
              p.threadContext,
            ),
          },
        ],
      },
      {
        threadId: `${ctx.owner}/${ctx.repo}#${ctx.entityNumber ?? "review"}`,
        debounceMs: config.commentDebounceMs,
        onProgress: mirrorProgress(p),
        onActivity: mirrorActivity(p),
        budget: budgetFrom(config),
        maxRuntimeMs: maxRuntimeMsFrom(config),
        recursionLimit: config.recursionLimit,
        maxRepeatedToolCalls: config.maxRepeatedToolCalls,
      },
    );
  } catch (err) {
    rmSync(reviewOutputDir, { recursive: true, force: true });
    throw err;
  }
  applyUsage(record, config.model, result.tokens);
  record.plan = result.todos;
  record.stopReason = result.stopped;
  record.stopDetail = result.stopDetail;
  record.pendingInterrupts = result.pendingInterrupts;
  record.activities = result.activities;

  if (result.stopped === "interrupt") {
    rmSync(reviewOutputDir, { recursive: true, force: true });
    record.summary = result.summary || "The review paused before an external tool was run.";
    record.status = "interrupted";
    if (commentId != null) {
      await updateTrackingComment(
        octokit,
        ctx,
        commentId,
        p.renderBody({
          status: "interrupted",
          instruction,
          todos: record.plan,
          summary: record.summary,
          interrupts: record.pendingInterrupts,
          activity: record.activities?.at(-1),
          stopReason: record.stopReason,
          stopDetail: record.stopDetail,
          tokens: record.tokens,
          costUsd: record.costUsd,
          runUrl: url,
          memory: appendTurn(p.priorMemory, {
            instruction,
            summary: record.summary,
            openTodos: record.plan,
          }),
        }),
      );
    }
    return;
  }

  // Read the findings the agent wrote (file-handoff).
  const review = readFindings(reviewOutputDir, result.summary);
  rmSync(reviewOutputDir, { recursive: true, force: true });
  let unhandled = review.findings;
  let fixSummary = "";

  if (p.applyFixes) {
    const { applied, unhandled: rest } = applyReviewSuggestions(
      rootDir,
      review.findings,
      new Set(files.map((file) => file.filename)),
    );
    unhandled = rest;
    if (applied.length > 0) {
      const land = await landChangesForRun(p, {
        isPRMode: true,
        instruction: `Apply ${applied.length} review suggestion(s)`,
        branchSuffix: p.branchSuffix,
        requireApproval: config.requirePushApproval,
      });
      record.filesChanged = land.filesChanged;
      record.branch = land.branch;
      record.prUrl = land.prUrl;
      record.approvalPending = land.approvalPending;
    }
    fixSummary = `${applied.length} suggestion(s) applied directly, ${unhandled.length} require manual review.`;
  }

  // Post the review — only the findings that weren't auto-applied still
  // surface as comments (an applied suggestion is already in the diff).
  await postReview(octokit, ctx, { summary: review.summary, findings: unhandled });
  record.summary = [
    `Reviewed ${files.length} file(s); posted ${unhandled.length} inline comment(s).`,
    fixSummary,
  ]
    .filter(Boolean)
    .join(" ");
  record.status = "success";

  if (commentId != null) {
    await updateTrackingComment(
      octokit,
      ctx,
      commentId,
      p.renderBody({
        status: "success",
        instruction,
        summary: `${record.summary}\n\n${review.summary}`,
        prUrl: record.prUrl,
        branch: record.branch,
        approvalPending: record.approvalPending,
        stopReason: record.stopReason,
        stopDetail: record.stopDetail,
        interrupts: record.pendingInterrupts,
        activity: record.activities?.at(-1),
        tokens: record.tokens,
        costUsd: record.costUsd,
        runUrl: url,
        memory: appendTurn(p.priorMemory, {
          instruction,
          summary: record.summary ?? "",
          prUrl: record.prUrl,
        }),
      }),
    );
  }
}

/** Read the agent-written isolated review handoff; fall back to a summary-only review. */
function readFindings(reviewOutputDir: string, fallbackSummary: string) {
  const path = join(reviewOutputDir, REVIEW_FINDINGS_FILE);
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
function applyUsage(record: RunRecord, model: string, tokens: TokenUsage): void {
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

run().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  await emitOutputs(buildFailureRecord(message, core.getInput("model") || "unknown")).catch(
    () => {},
  );
  core.setFailed(`Deep Agent action crashed: ${message}`);
});
