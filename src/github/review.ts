import * as core from "@actions/core";
import { z } from "zod";
import type { Octokit } from "./client.js";
import type { GitHubContext } from "../types.js";

export interface ReviewFinding {
  path: string;
  line: number;
  body: string;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
}

/**
 * Schema for the agent-written findings JSON. Fields are coerced (not rejected)
 * to mirror the prior lenient `String()`/`Number()` behavior — `String(x ?? "")`
 * and `Number(x ?? 0)` — so malformed entries become empty/zero and are dropped
 * by the caller's filter rather than aborting the parse.
 */
const FindingSchema = z.object({
  path: z.unknown().transform((v) => String(v ?? "")),
  line: z.unknown().transform((v) => Number(v ?? 0)),
  body: z.unknown().transform((v) => String(v ?? "")),
});

const ReviewResultSchema = z.object({
  summary: z.string().catch(""),
  findings: z.array(FindingSchema).catch([]),
});

/** Path (relative to the workspace) the review agent writes its findings to. */
export const REVIEW_FINDINGS_FILE = ".deep-agent-review.json";

/** Fetch the changed files (with patches) for the PR under review. */
export async function fetchPrFiles(
  octokit: Octokit,
  ctx: GitHubContext,
): Promise<{ filename: string; patch?: string }[]> {
  if (ctx.entityNumber == null) return [];
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.entityNumber,
    per_page: 100,
  });
  return files.map((f) => ({ filename: f.filename, patch: f.patch }));
}

/** Validate/coerce the agent-written findings JSON (pure, testable). */
export function parseFindings(raw: unknown): ReviewResult {
  const { summary, findings } = ReviewResultSchema.safeParse(raw ?? {}).data ?? {
    summary: "",
    findings: [],
  };
  return { summary, findings: findings.filter((f) => f.path && f.line > 0 && f.body) };
}

/**
 * Post a review with inline comments. If GitHub rejects the inline comments
 * (e.g. a line that isn't part of the diff), fall back to a single review whose
 * body folds the findings in, so feedback is never lost.
 */
export async function postReview(
  octokit: Octokit,
  ctx: GitHubContext,
  result: ReviewResult,
): Promise<void> {
  if (ctx.entityNumber == null) return;
  const base = { owner: ctx.owner, repo: ctx.repo, pull_number: ctx.entityNumber };
  const summary = result.summary || "Deep Agent review.";

  if (result.findings.length === 0) {
    await octokit.rest.pulls.createReview({ ...base, event: "COMMENT", body: summary });
    return;
  }

  try {
    await octokit.rest.pulls.createReview({
      ...base,
      event: "COMMENT",
      body: summary,
      comments: result.findings.map((f) => ({
        path: f.path,
        line: f.line,
        side: "RIGHT",
        body: f.body,
      })),
    });
  } catch (err) {
    core.warning(
      `Inline review comments rejected; posting a summary instead: ${err instanceof Error ? err.message : err}`,
    );
    const folded = [
      summary,
      "",
      ...result.findings.map((f) => `- \`${f.path}:${f.line}\` — ${f.body}`),
    ].join("\n");
    await octokit.rest.pulls.createReview({ ...base, event: "COMMENT", body: folded });
  }
}
