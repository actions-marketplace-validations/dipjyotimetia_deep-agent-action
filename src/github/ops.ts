import { execFileSync } from "node:child_process";
import { githubServerUrl, type Octokit } from "./client.js";
import { truncateBody } from "./text.js";
import type { GitHubContext } from "../types.js";

/**
 * Run git with arguments (no shell — args are passed directly, injection-safe).
 * Failures are rethrown with the stderr detail (execFileSync puts it on the
 * error object, not in `message`) and any authenticated remote URL redacted:
 * git errors can echo the tokenized URL, and the message lands in the tracking
 * comment, outputs, and audit record, where `core.setSecret` masking does not
 * apply.
 */
export function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    const detail =
      typeof e.stderr === "string" && e.stderr.trim()
        ? e.stderr.trim()
        : (e.message ?? String(err));
    throw new Error(
      `git ${args[0]} failed: ${detail}`.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@"),
    );
  }
}

/** Run `git push`, layering actionable hints onto known rejection messages. */
function runGitPush(args: string[], cwd: string): void {
  try {
    runGit(args, cwd);
  } catch (err) {
    throw new Error(explainGitHubError(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Augment known, common GitHub API failures with an actionable hint. Returns the
 * original message unchanged when we have no specific guidance.
 */
export function explainGitHubError(message: string): string {
  if (/not permitted to create or approve pull requests/i.test(message)) {
    return (
      `${message}\n\n` +
      `The GITHUB_TOKEN cannot open pull requests until a maintainer enables ` +
      `"Allow GitHub Actions to create and approve pull requests" under repo ` +
      `Settings → Actions → General → Workflow permissions — or you configure a ` +
      `GitHub App via the app_id / app_private_key inputs.`
    );
  }
  if (/protected branch|GH006/i.test(message)) {
    return (
      `${message}\n\n` +
      `The target branch has protection rules this token cannot satisfy. Enable ` +
      `require_push_approval so changes land on a proposed branch instead, or adjust ` +
      `the branch protection (e.g. add the GitHub App to its bypass list).`
    );
  }
  if (/non-fast-forward|fetch first|failed to push some refs/i.test(message)) {
    return (
      `${message}\n\n` +
      `The branch moved while the agent was working (e.g. a concurrent push or a ` +
      `second simultaneous mention). Re-run the request; a workflow-level ` +
      `concurrency group (see the README quickstart) serializes agent runs per issue/PR.`
    );
  }
  return message;
}

/** Sanitize a string into a valid, safe git branch component. */
export function sanitizeBranchName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 240);
}

/**
 * Build a branch name for issue/dispatch runs. Stable per issue (e.g.
 * `deep-agent/issue-12`) so a follow-up mention reuses the same branch/PR
 * instead of opening a new one each run; falls back to a run-scoped name
 * (`deep-agent/dispatch-<suffix>`) only when there's no issue/PR to key off
 * (a bare `workflow_dispatch`).
 */
export function generateBranchName(ctx: GitHubContext, suffix: string): string {
  if (ctx.entityNumber != null) {
    const kind = ctx.isPR ? "pr" : "issue";
    return sanitizeBranchName(`deep-agent/${kind}-${ctx.entityNumber}`);
  }
  return sanitizeBranchName(`deep-agent/dispatch-${suffix}`);
}

/** The branch currently checked out in the workspace. */
export function getCurrentBranch(rootDir: string): string {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], rootDir);
}

/**
 * If `branch` already exists on the remote, fetch and check it out so the
 * agent's edits (and the eventual commit) land on top of prior continuation
 * work instead of the current default-branch HEAD. Returns false (and leaves
 * the workspace untouched) when the branch doesn't exist remotely yet.
 */
export function checkoutIssueBranchIfExists(
  rootDir: string,
  token: string,
  owner: string,
  repo: string,
  branch: string,
): boolean {
  const url = pushUrl(token, owner, repo);
  try {
    runGit(["fetch", "--depth=1", url, branch], rootDir);
  } catch {
    return false;
  }
  runGit(["checkout", "-B", branch, "FETCH_HEAD"], rootDir);
  return true;
}

/** Files with uncommitted changes in the workspace. */
export function listChangedFiles(rootDir: string): string[] {
  const out = runGit(["status", "--porcelain"], rootDir);
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/** Configure the bot commit identity. */
export function configureGitIdentity(
  rootDir: string,
  identity: { name: string; email: string },
): void {
  runGit(["config", "user.name", identity.name], rootDir);
  runGit(["config", "user.email", identity.email], rootDir);
}

/** Derive the authenticated push URL (token kept out of persisted git config). */
function pushUrl(token: string, owner: string, repo: string): string {
  const host = githubServerUrl().replace(/^https?:\/\//, "");
  return `https://x-access-token:${token}@${host}/${owner}/${repo}.git`;
}

/** The commit/PR title derived from the instruction's first line. */
export function commitTitle(instruction: string): string {
  return `Deep Agent: ${instruction.split("\n")[0]!.slice(0, 72)}`;
}

/** Branch name for a PR-mode "proposed" landing (approval-gated, doesn't touch the PR branch). */
export function proposedBranchName(ctx: GitHubContext, suffix: string): string {
  return sanitizeBranchName(`deep-agent/proposed/${ctx.entityNumber}-${suffix}`);
}

/** Compare-view URL between the PR's head and a proposed branch. */
export function compareUrl(ctx: GitHubContext, headRef: string, proposed: string): string {
  return `${githubServerUrl()}/${ctx.owner}/${ctx.repo}/compare/${headRef}...${proposed}?expand=1`;
}

/** The PR body used when opening a new issue/dispatch-mode pull request. */
export function buildPrBody(ctx: GitHubContext, instruction: string): string {
  return [
    `This pull request was opened by the Deep Agent in response to a request${
      ctx.entityNumber != null ? ` on #${ctx.entityNumber}` : ""
    }.`,
    "",
    "**Requested change:**",
    "",
    instruction,
  ].join("\n");
}

/**
 * Look for an existing (non-merged) PR whose head is `branch` and reuse it —
 * reopening it first if it was closed — instead of opening a second PR for
 * the same issue across separate mentions. Returns its URL when reused,
 * undefined when the caller should create a new PR.
 */
export async function reuseExistingPr(
  octokit: Octokit,
  ctx: GitHubContext,
  branch: string,
): Promise<string | undefined> {
  const existing = await octokit.rest.pulls
    .list({ owner: ctx.owner, repo: ctx.repo, head: `${ctx.owner}:${branch}`, state: "all" })
    .then((res) => res.data.find((p) => !p.merged_at))
    .catch(() => undefined);
  if (!existing) return undefined;
  if (existing.state === "closed") {
    await octokit.rest.pulls
      .update({ owner: ctx.owner, repo: ctx.repo, pull_number: existing.number, state: "open" })
      .catch(() => {});
  }
  return existing.html_url;
}

export interface LandResult {
  filesChanged: string[];
  branch?: string;
  prUrl?: string;
  /** True when the result is gated for review (draft PR / proposed branch). */
  approvalPending?: boolean;
}

/**
 * Check out a PR's head branch before the agent runs. `actions/checkout`
 * leaves the default branch checked out for `issue_comment` events, so in PR
 * mode we must fetch and switch to the PR head — otherwise the agent edits the
 * wrong tree and the later push is a non-fast-forward. Same-repo PRs only
 * (fork PRs are blocked earlier by fork protection).
 */
export function checkoutPrHead(
  rootDir: string,
  token: string,
  owner: string,
  repo: string,
  ref: string,
): void {
  const url = pushUrl(token, owner, repo);
  runGit(["fetch", "--depth=1", url, ref], rootDir);
  runGit(["checkout", "-B", ref, "FETCH_HEAD"], rootDir);
}

/**
 * Commit the agent's changes and either push to the existing PR branch (PR
 * mode) or create a new branch and open a pull request (issue/dispatch mode).
 * The authenticated push is performed here by the control plane, never by the
 * agent.
 */
export async function landChanges(params: {
  octokit: Octokit;
  ctx: GitHubContext;
  rootDir: string;
  token: string;
  isPRMode: boolean;
  instruction: string;
  identity: { name: string; email: string };
  branchSuffix: string;
  /** Gate landing behind human review (draft PR / proposed branch). */
  requireApproval: boolean;
  /**
   * True when the workspace was already checked out onto the target issue
   * branch (via `checkoutIssueBranchIfExists`) before the agent ran — the
   * commit above already landed on top of that branch, so it only needs a
   * push, not a fresh `git branch`.
   */
  continuingBranch?: boolean;
  /** The repo's default branch, captured before any continuation checkout. */
  baseBranch?: string;
}): Promise<LandResult> {
  const { octokit, ctx, rootDir, token, isPRMode, instruction, identity, branchSuffix } = params;

  const filesChanged = listChangedFiles(rootDir);
  if (filesChanged.length === 0) return { filesChanged };

  configureGitIdentity(rootDir, identity);

  const title = commitTitle(instruction);
  const url = pushUrl(token, ctx.owner, ctx.repo);

  runGit(["add", "-A"], rootDir);
  runGit(["commit", "-m", title], rootDir);

  if (isPRMode) {
    if (!ctx.prHeadRef) {
      throw new Error("PR mode requires a resolved head branch (prHeadRef); cannot push changes.");
    }
    if (params.requireApproval) {
      // Don't touch the PR branch; push a proposed branch + compare link for review.
      const proposed = proposedBranchName(ctx, branchSuffix);
      runGitPush(["push", url, `HEAD:refs/heads/${proposed}`], rootDir);
      const compare = compareUrl(ctx, ctx.prHeadRef, proposed);
      return { filesChanged, branch: proposed, prUrl: compare, approvalPending: true };
    }
    // Push to the existing PR branch (same-repo only).
    runGitPush(["push", url, `HEAD:refs/heads/${ctx.prHeadRef}`], rootDir);
    return { filesChanged, branch: ctx.prHeadRef };
  }

  // Issue/dispatch: reuse the issue's existing deep-agent branch/PR when one
  // already exists (continuity across separate mentions), otherwise branch
  // off the current HEAD and open a new PR.
  const branch = generateBranchName(ctx, branchSuffix);
  const baseBranch = params.baseBranch ?? runGit(["rev-parse", "--abbrev-ref", "HEAD"], rootDir);
  if (params.continuingBranch) {
    runGitPush(["push", url, `HEAD:refs/heads/${branch}`], rootDir);
  } else {
    runGit(["branch", branch], rootDir);
    runGitPush(["push", url, `${branch}:refs/heads/${branch}`], rootDir);
  }

  // Reuse an existing (non-merged) PR for this branch instead of opening a
  // second one for the same issue.
  const reusedPrUrl = await reuseExistingPr(octokit, ctx, branch);
  if (reusedPrUrl) {
    return { filesChanged, branch, prUrl: reusedPrUrl, approvalPending: params.requireApproval };
  }

  const pr = await octokit.rest.pulls
    .create({
      owner: ctx.owner,
      repo: ctx.repo,
      head: branch,
      base: baseBranch,
      title,
      body: truncateBody(buildPrBody(ctx, instruction)),
      draft: params.requireApproval,
    })
    .catch((err: unknown) => {
      throw new Error(explainGitHubError(err instanceof Error ? err.message : String(err)));
    });

  return { filesChanged, branch, prUrl: pr.data.html_url, approvalPending: params.requireApproval };
}

/** Resolve the bot commit identity from the App slug (or a generic fallback). */
export async function resolveBotIdentity(
  octokit: Octokit,
  appSlug: string | undefined,
): Promise<{ name: string; email: string }> {
  const slug = appSlug ?? "deep-agent";
  const login = `${slug}[bot]`;
  try {
    const { data } = await octokit.rest.users.getByUsername({ username: login });
    return { name: login, email: `${data.id}+${login}@users.noreply.github.com` };
  } catch {
    return { name: login, email: `${login}@users.noreply.github.com` };
  }
}
