/**
 * Thin `gh`/`git` CLI wrappers for creating and cleaning up the synthetic
 * issues/PRs/comments the live dogfood scenarios (scripts/e2e/live/scenario-*.ts)
 * use to fire real GitHub events. Every synthetic entity is labeled
 * `e2e-synthetic` and its title is suffixed with a run-scoped, unique string so
 * concurrent scenario runs never collide.
 */
import { appendFileSync } from "node:fs";

export const SYNTHETIC_LABEL = "e2e-synthetic";

/** Write a step output (`name=value`) for the workflow's cleanup step to read; a no-op outside Actions. */
export function writeOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `${name}=${value}\n`);
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** The repo this script is running against, from the Actions-provided env var. */
export function currentRepo(): RepoRef {
  const full = process.env.GITHUB_REPOSITORY;
  if (!full)
    throw new Error("GITHUB_REPOSITORY is not set (expected to run inside GitHub Actions)");
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`invalid GITHUB_REPOSITORY: ${full}`);
  return { owner, repo };
}

/** A short, unique suffix for synthetic titles/branches: `<run id>-<random>`. */
export function syntheticSuffix(): string {
  const runId = process.env.GITHUB_RUN_ID ?? "local";
  const slug = Math.random().toString(36).slice(2, 8);
  return `${runId}-${slug}`;
}

/** Run a CLI command, returning trimmed stdout; throws with stderr on non-zero exit. */
export async function runCmd(cmd: string[], opts: { cwd?: string } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd: opts.cwd });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed: ${err || out}`);
  return out.trim();
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export async function createSyntheticIssue(opts: {
  title: string;
  body: string;
  labels?: string[];
}): Promise<CreatedIssue> {
  const { owner, repo } = currentRepo();
  const labels = [SYNTHETIC_LABEL, ...(opts.labels ?? [])].join(",");
  const url = await runCmd([
    "gh",
    "issue",
    "create",
    "-R",
    `${owner}/${repo}`,
    "--title",
    opts.title,
    "--body",
    opts.body,
    "--label",
    labels,
  ]);
  const number = Number(url.split("/").pop());
  return { number, url };
}

export async function commentOnIssue(number: number, body: string): Promise<void> {
  const { owner, repo } = currentRepo();
  await runCmd([
    "gh",
    "issue",
    "comment",
    String(number),
    "-R",
    `${owner}/${repo}`,
    "--body",
    body,
  ]);
}

/** Post a normal conversation comment on a PR (fires `issue_comment` with `isPR=true`). */
export async function commentOnPr(prNumberOrUrl: string | number, body: string): Promise<void> {
  await runCmd(["gh", "pr", "comment", String(prNumberOrUrl), "--body", body]);
}

export async function addLabel(number: number, label: string): Promise<void> {
  const { owner, repo } = currentRepo();
  await runCmd([
    "gh",
    "issue",
    "edit",
    String(number),
    "-R",
    `${owner}/${repo}`,
    "--add-label",
    label,
  ]);
}

/** Best-effort — cleanup should never fail the job over an already-closed issue. */
export async function closeIssue(number: number): Promise<void> {
  const { owner, repo } = currentRepo();
  await runCmd(["gh", "issue", "close", String(number), "-R", `${owner}/${repo}`]).catch(() => {});
}

export interface CreatedPr {
  number: number;
  url: string;
  branch: string;
}

export async function createSyntheticPr(opts: {
  branch: string;
  base?: string;
  title: string;
  body: string;
}): Promise<CreatedPr> {
  const { owner, repo } = currentRepo();
  const url = await runCmd([
    "gh",
    "pr",
    "create",
    "-R",
    `${owner}/${repo}`,
    "--head",
    opts.branch,
    "--base",
    opts.base ?? "main",
    "--title",
    opts.title,
    "--body",
    opts.body,
    "--label",
    SYNTHETIC_LABEL,
  ]);
  const number = Number(url.split("/").pop());
  return { number, url, branch: opts.branch };
}

/** Best-effort — cleanup should never fail the job over an already-closed PR. */
export async function closePr(url: string): Promise<void> {
  await runCmd(["gh", "pr", "close", url, "--delete-branch"]).catch(() => {});
}

/** File paths changed in a PR, one per entry. */
export async function prFilePaths(prNumberOrUrl: string | number): Promise<string[]> {
  const { owner, repo } = currentRepo();
  const out = await runCmd([
    "gh",
    "pr",
    "view",
    String(prNumberOrUrl),
    "-R",
    `${owner}/${repo}`,
    "--json",
    "files",
    "--jq",
    ".files[].path",
  ]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Number of review objects (not just comments) posted on a PR. */
export async function prReviewCount(prNumberOrUrl: string | number): Promise<number> {
  const { owner, repo } = currentRepo();
  const number =
    typeof prNumberOrUrl === "number"
      ? prNumberOrUrl
      : Number(String(prNumberOrUrl).split("/").pop());
  const out = await runCmd([
    "gh",
    "api",
    `repos/${owner}/${repo}/pulls/${number}/reviews`,
    "--jq",
    "length",
  ]);
  return Number(out);
}
