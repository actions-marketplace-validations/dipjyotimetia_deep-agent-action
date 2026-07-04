import * as core from "@actions/core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Octokit } from "./client.js";
import type { GitHubContext } from "../types.js";
import { truncateBody } from "./text.js";

const SEVERITIES = ["critical", "warning", "info"] as const;
export type FindingSeverity = (typeof SEVERITIES)[number];

export interface ReviewFinding {
  path: string;
  line: number;
  body: string;
  /** Optional rank; absent when the agent didn't (or couldn't validly) rank it. */
  severity?: FindingSeverity;
  /** Optional verbatim replacement for the commented line(s), rendered as a GitHub suggestion. */
  suggestion?: string;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
}

/**
 * Schema for one agent-written finding. Coerces at the *element* level (via
 * `z.unknown()`, which accepts non-objects like `null`) to mirror the prior
 * lenient `String(x ?? "")` / `Number(x ?? 0)` behavior: malformed entries
 * become empty/zero and are dropped by the caller's filter rather than failing
 * the surrounding array — so one bad element never discards the whole batch.
 */
const FindingSchema = z.unknown().transform((f): ReviewFinding => {
  const r = (f ?? {}) as {
    path?: unknown;
    line?: unknown;
    body?: unknown;
    severity?: unknown;
    suggestion?: unknown;
  };
  return {
    path: String(r.path ?? ""),
    line: Number(r.line ?? 0),
    body: String(r.body ?? ""),
    severity: normalizeSeverity(r.severity),
    suggestion: typeof r.suggestion === "string" && r.suggestion.trim() ? r.suggestion : undefined,
  };
});

/** Lenient severity coercion: unknown/malformed values become undefined, never a parse failure. */
function normalizeSeverity(raw: unknown): FindingSeverity | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  return (SEVERITIES as readonly string[]).includes(s) ? (s as FindingSeverity) : undefined;
}

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

const SEVERITY_PREFIXES: Record<FindingSeverity, string> = {
  critical: "**[Critical]** ",
  warning: "**[Warning]** ",
  info: "**[Info]** ",
};

/**
 * Render one finding's comment body: bold severity prefix, the comment text,
 * and — when the agent proposed a concrete fix — a GitHub `suggestion` fence
 * the reviewer can apply with one click. Pure and testable.
 */
export function formatFindingBody(f: ReviewFinding): string {
  let out = `${f.severity ? SEVERITY_PREFIXES[f.severity] : ""}${f.body}`;
  if (f.suggestion) {
    // A suggestion containing a triple-backtick fence needs a longer outer fence.
    const fence = f.suggestion.includes("```") ? "````" : "```";
    out += `\n\n${fence}suggestion\n${f.suggestion}\n${fence}`;
  }
  return out;
}

/**
 * Apply a finding's single-line `suggestion` as a verbatim replacement of
 * `line` (1-based) in `fileText`. Pure and testable in isolation. Returns the
 * text unchanged if `line` is out of range (the file may have moved since the
 * diff was reviewed).
 */
export function applySuggestion(fileText: string, line: number, suggestion: string): string {
  const lines = fileText.split("\n");
  if (line < 1 || line > lines.length) return fileText;
  lines[line - 1] = suggestion;
  return lines.join("\n");
}

/**
 * Partition findings into those with a directly-applicable single-line
 * `suggestion` and everything else. Within each file, callers must apply
 * `applicable` findings from the highest line number down so earlier edits
 * don't shift the line numbers of edits still pending in the same file.
 */
export function partitionApplicableFindings(findings: ReviewFinding[]): {
  applicable: ReviewFinding[];
  unhandled: ReviewFinding[];
} {
  const applicable: ReviewFinding[] = [];
  const unhandled: ReviewFinding[] = [];
  for (const f of findings) {
    (f.suggestion && f.line > 0 ? applicable : unhandled).push(f);
  }
  return { applicable, unhandled };
}

/**
 * Apply every applicable finding's single-line suggestion directly to the
 * files on disk, grouped by path and applied highest-line-first within each
 * file so earlier edits don't invalidate the line numbers of edits still
 * pending in the same file. Findings whose file doesn't exist on disk are
 * moved to `unhandled` instead of applied.
 */
export function applyReviewSuggestions(
  rootDir: string,
  findings: ReviewFinding[],
): { applied: ReviewFinding[]; unhandled: ReviewFinding[] } {
  const { applicable, unhandled } = partitionApplicableFindings(findings);
  const applied: ReviewFinding[] = [];

  const byPath = new Map<string, ReviewFinding[]>();
  for (const f of applicable) {
    const bucket = byPath.get(f.path) ?? [];
    bucket.push(f);
    byPath.set(f.path, bucket);
  }

  for (const [path, fileFindings] of byPath) {
    const abs = join(rootDir, path);
    if (!existsSync(abs)) {
      unhandled.push(...fileFindings);
      continue;
    }
    let text = readFileSync(abs, "utf8");
    for (const f of [...fileFindings].sort((a, b) => b.line - a.line)) {
      text = applySuggestion(text, f.line, f.suggestion!);
      applied.push(f);
    }
    writeFileSync(abs, text, "utf8");
  }

  return { applied, unhandled };
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
    await octokit.rest.pulls.createReview({
      ...base,
      event: "COMMENT",
      body: truncateBody(summary),
    });
    return;
  }

  const bodies = result.findings.map((f) => truncateBody(formatFindingBody(f)));
  try {
    await octokit.rest.pulls.createReview({
      ...base,
      event: "COMMENT",
      body: truncateBody(summary),
      comments: result.findings.map((f, i) => ({
        path: f.path,
        line: f.line,
        side: "RIGHT",
        body: bodies[i]!,
      })),
    });
  } catch (err) {
    core.warning(
      `Inline review comments rejected; posting a summary instead: ${err instanceof Error ? err.message : err}`,
    );
    const folded = [
      summary,
      "",
      ...result.findings.map((f, i) => `- \`${f.path}:${f.line}\` — ${bodies[i]!}`),
    ].join("\n");
    await octokit.rest.pulls.createReview({
      ...base,
      event: "COMMENT",
      body: truncateBody(folded),
    });
  }
}
