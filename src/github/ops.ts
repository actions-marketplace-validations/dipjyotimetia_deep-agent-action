import { execFileSync } from "node:child_process";
import { githubServerUrl, type Octokit } from "./client.js";
import type { GitHubContext } from "../types.js";

/** Run git with arguments (no shell — args are passed directly, injection-safe). */
function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Sanitize a string into a valid, safe git branch component. */
export function sanitizeBranchName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 240);
}

/** Build a branch name for issue/dispatch runs, e.g. `deep-agent/issue-12-987654`. */
export function generateBranchName(ctx: GitHubContext, suffix: string): string {
  const kind = ctx.isPR ? "pr" : ctx.entityNumber != null ? "issue" : "dispatch";
  const num = ctx.entityNumber != null ? `-${ctx.entityNumber}` : "";
  return sanitizeBranchName(`deep-agent/${kind}${num}-${suffix}`);
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

export interface LandResult {
  filesChanged: string[];
  branch?: string;
  prUrl?: string;
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
}): Promise<LandResult> {
  const { octokit, ctx, rootDir, token, isPRMode, instruction, identity, branchSuffix } = params;

  const filesChanged = listChangedFiles(rootDir);
  if (filesChanged.length === 0) return { filesChanged };

  configureGitIdentity(rootDir, identity);

  const title = `Deep Agent: ${instruction.split("\n")[0]!.slice(0, 72)}`;
  const url = pushUrl(token, ctx.owner, ctx.repo);

  runGit(["add", "-A"], rootDir);
  runGit(["commit", "-m", title], rootDir);

  if (isPRMode && ctx.prHeadRef) {
    // Push to the existing PR branch (same-repo only).
    runGit(["push", url, `HEAD:refs/heads/${ctx.prHeadRef}`], rootDir);
    return { filesChanged, branch: ctx.prHeadRef };
  }

  // Issue/dispatch: branch off the current HEAD and open a PR.
  const baseBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], rootDir);
  const branch = generateBranchName(ctx, branchSuffix);
  runGit(["branch", branch], rootDir);
  runGit(["push", url, `${branch}:refs/heads/${branch}`], rootDir);

  const body = [
    `This pull request was opened by the Deep Agent in response to a request${
      ctx.entityNumber != null ? ` on #${ctx.entityNumber}` : ""
    }.`,
    "",
    "**Requested change:**",
    "",
    instruction,
  ].join("\n");

  const pr = await octokit.rest.pulls.create({
    owner: ctx.owner,
    repo: ctx.repo,
    head: branch,
    base: baseBranch,
    title,
    body,
  });

  return { filesChanged, branch, prUrl: pr.data.html_url };
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
