import type { GitHubContext } from "../types.js";
import { REVIEW_FINDINGS_FILE } from "../github/review.js";

/**
 * Build the system prompt that sets the agent's role and conventions. The
 * user's actual instruction is delivered as the first user message, not here.
 */
export function buildSystemPrompt(ctx: GitHubContext, opts: { isPRMode: boolean }): string {
  const repo = `${ctx.owner}/${ctx.repo}`;
  return [
    `You are an autonomous software engineering agent operating on the GitHub repository ${repo}.`,
    `The repository is checked out at the current working directory. You can read and edit files,`,
    `and run shell commands via the \`execute\` tool. Network access and credentials are intentionally`,
    `unavailable in your shell — do not attempt to push, fetch remotes, or call external services.`,
    ``,
    `Guidelines:`,
    `- Use the \`write_todos\` tool to plan multi-step work and keep the plan updated as you progress.`,
    `- Make the smallest change that satisfies the request. Match the existing code style.`,
    `- Run the repository's existing tests and linters before you finish, if they are available.`,
    `- Do not commit, push, or open a pull request yourself — the surrounding workflow handles that`,
    `  once you finish editing files. Just leave the working tree in the desired final state.`,
    `- When you are done, end with a concise summary of what you changed and why.`,
    opts.isPRMode
      ? `- This run targets an existing pull request; your changes will be committed to its branch.`
      : `- Your changes will be committed to a new branch and opened as a pull request for review.`,
  ].join("\n");
}

/** Build the initial user message containing the resolved instruction. */
export function buildUserMessage(instruction: string, ctx: GitHubContext): string {
  const where = ctx.entityNumber
    ? `${ctx.isPR ? "pull request" : "issue"} #${ctx.entityNumber}`
    : "a manual dispatch";
  return `The following request was made on ${where}:\n\n${instruction}`;
}

/** System prompt for code-review mode: read-only, write findings to a file. */
export function buildReviewSystemPrompt(ctx: GitHubContext): string {
  const repo = `${ctx.owner}/${ctx.repo}`;
  return [
    `You are a code reviewer for the GitHub repository ${repo}, reviewing a pull request.`,
    `The repository is checked out at the current working directory and you can read files and`,
    `run read-only shell commands via \`execute\`. Do NOT edit, commit, or push anything.`,
    ``,
    `Review the changed files for correctness bugs, security issues, and clear quality problems.`,
    `Focus on lines that the diff actually adds or changes — only comment on those.`,
    ``,
    `When finished, write your review as JSON to the file \`${REVIEW_FINDINGS_FILE}\` in the`,
    `repository root using the \`write_file\` tool, with exactly this shape:`,
    `{ "summary": "<overall summary>", "findings": [ { "path": "<file>", "line": <number>, "body": "<comment>" } ] }`,
    `Use an empty findings array if the change looks good. Then end with a one-line summary.`,
  ].join("\n");
}

/** User message for review mode: the list of changed files and their patches. */
export function buildReviewUserMessage(
  instruction: string,
  files: { filename: string; patch?: string }[],
): string {
  const diff = files
    .map(
      (f) =>
        `### ${f.filename}\n${f.patch ? "```diff\n" + f.patch + "\n```" : "(no patch available)"}`,
    )
    .join("\n\n");
  return [
    instruction ? `Review request: ${instruction}` : "Review this pull request.",
    "",
    "Changed files:",
    "",
    diff,
  ].join("\n");
}
