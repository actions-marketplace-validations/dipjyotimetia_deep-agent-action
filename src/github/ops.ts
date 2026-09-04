import { execFileSync } from "node:child_process";
import { githubServerUrl, type Octokit } from "./client.js";
import { truncateBody } from "./text.js";
import type { GitHubContext } from "../types.js";

/** Normalize porcelain output into every affected repository-relative path. */
export function changedPathsFromPorcelain(porcelain: string): string[] {
  if (porcelain.includes("\0")) return changedPathsFromPorcelainZ(porcelain);
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const value = line.slice(3).trim();
    if ((status.includes("R") || status.includes("C")) && value.includes(" -> ")) {
      paths.push(
        ...value
          .split(" -> ")
          .map((path) => path.trim())
          .filter(Boolean),
      );
    } else if (value) {
      paths.push(value);
    }
  }
  return paths;
}

/**
 * Parse `git status --porcelain=v1 -z` without relying on Git's display
 * quoting. A rename/copy carries a second NUL-delimited source path.
 */
function changedPathsFromPorcelainZ(porcelain: string): string[] {
  const records = porcelain.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path) paths.push(path);
    if (status.includes("R") || status.includes("C")) {
      const source = records[++i];
      if (source) paths.push(source);
    }
  }
  return paths;
}

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

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
    const e = err as { stderr?: unknown; message?: string; status?: unknown };
    const detail =
      typeof e.stderr === "string" && e.stderr.trim()
        ? e.stderr.trim()
        : (e.message ?? String(err));
    throw new GitCommandError(
      `git ${args[0]} failed: ${detail}`.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@"),
      typeof e.status === "number" ? e.status : undefined,
    );
  }
}

/** Git returns exit status 2 when `ls-remote --exit-code` finds no matching ref. */
export function isMissingRemoteBranchStatus(status: number | undefined): boolean {
  return status === 2;
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

/** Build the run-scoped suffix used when no issue or PR identifies the branch. */
export function buildRunBranchSuffix(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DEEP_AGENT_INVOCATION_ID) {
    return env.DEEP_AGENT_INVOCATION_ID;
  }
  return [env.GITHUB_RUN_ID || "run", env.GITHUB_RUN_ATTEMPT, env.GITHUB_JOB, env.GITHUB_ACTION]
    .filter((part): part is string => Boolean(part))
    .join("-");
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
    runGit(["ls-remote", "--exit-code", "--heads", url, `refs/heads/${branch}`], rootDir);
  } catch (err) {
    if (err instanceof GitCommandError && isMissingRemoteBranchStatus(err.status)) return false;
    throw err;
  }
  runGit(["fetch", "--depth=1", url, branch], rootDir);
  runGit(["checkout", "-B", branch, "FETCH_HEAD"], rootDir);
  return true;
}

/** Files with uncommitted changes in the workspace. */
export function listChangedFiles(rootDir: string): string[] {
  const out = runGit(["status", "--porcelain=v1", "-z"], rootDir);
  return changedPathsFromPorcelain(out);
}

/**
 * Remove credentials persisted by actions/checkout before the model can invoke
 * allow-listed `git` commands. Control-plane fetch/push uses explicit tokenized
 * URLs, never the checkout's local credential configuration.
 */
export function stripCheckoutCredentials(rootDir: string, originUrl?: string): void {
  try {
    const keys = runGit(
      ["config", "--local", "--name-only", "--get-regexp", "^http\\..*\\.extraheader$"],
      rootDir,
    )
      .split("\n")
      .filter(Boolean);
    for (const key of keys) runGit(["config", "--local", "--unset-all", key], rootDir);
  } catch {
    // No persisted checkout header is the common local-development case.
  }
  try {
    runGit(["config", "--local", "--unset-all", "credential.helper"], rootDir);
  } catch {
    // No local credential helper is also expected in a clean checkout.
  }
  if (originUrl) {
    try {
      runGit(["remote", "set-url", "origin", originUrl], rootDir);
    } catch {
      // Some tests/manual workflows do not configure origin; control-plane URLs
      // remain explicit, so a missing remote cannot restore agent credentials.
    }
  }
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
 * the same issue across separate mentions. When approval is required, convert
 * a ready PR to draft before reporting it as gated. Returns the URL and actual
 * draft state when reused, or undefined when the caller should create a new PR.
 */
export interface ReusedPullRequest {
  url: string;
  isDraft: boolean;
}

const CONVERT_PULL_REQUEST_TO_DRAFT = `
  mutation($pullRequestId: ID!) {
    convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
      pullRequest { isDraft }
    }
  }
`;

export async function reuseExistingPr(
  octokit: Octokit,
  ctx: GitHubContext,
  branch: string,
  opts: { requireDraft?: boolean } = {},
): Promise<ReusedPullRequest | undefined> {
  const existing = await octokit.rest.pulls
    .list({ owner: ctx.owner, repo: ctx.repo, head: `${ctx.owner}:${branch}`, state: "all" })
    .then((res) => res.data.find((p) => !p.merged_at));
  if (!existing) return undefined;
  if (existing.state === "closed") {
    await octokit.rest.pulls.update({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: existing.number,
      state: "open",
    });
  }

  let isDraft = Boolean(existing.draft);
  if (opts.requireDraft && !isDraft) {
    if (!existing.node_id) {
      throw new Error(`Cannot convert pull request #${existing.number} to draft: missing node id.`);
    }
    const converted = await octokit.graphql<{
      convertPullRequestToDraft: { pullRequest: { isDraft: boolean } };
    }>(CONVERT_PULL_REQUEST_TO_DRAFT, { pullRequestId: existing.node_id });
    isDraft = converted.convertPullRequestToDraft.pullRequest.isDraft;
    if (!isDraft) {
      throw new Error(`GitHub did not convert pull request #${existing.number} to draft.`);
    }
  }
  return { url: existing.html_url, isDraft };
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
  const reusedPr = await reuseExistingPr(octokit, ctx, branch, {
    requireDraft: params.requireApproval,
  });
  if (reusedPr) {
    return {
      filesChanged,
      branch,
      prUrl: reusedPr.url,
      approvalPending: reusedPr.isDraft,
    };
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
