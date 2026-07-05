/**
 * Live regression test for the thread-context fix (src/github/thread.ts):
 * reproduces the restura#442 shape — a vague issue, the real detail arriving
 * as a follow-up human comment, then a bare "@e2e-agent" mention — and
 * asserts the agent's response is actually informed by that follow-up
 * comment, not just the bare mention.
 *
 * The canary is an *actionable instruction* only the follow-up comment
 * carries (add a specific empty file), not a prose token to substring-match —
 * an LLM can quote a canary phrase from context without acting on it, but it
 * can't produce the canary *file* in its PR without having read that comment.
 *
 * Requires: .github/workflows/e2e-live-events.yml already deployed on the
 * default branch — this script only creates the GitHub events; the reactive
 * workflow does the rest.
 *
 * CLI: bun run scripts/e2e/live/scenario-thread-context.ts
 */
import {
  createSyntheticIssue,
  commentOnIssue,
  currentRepo,
  prFilePaths,
  syntheticSuffix,
  writeOutput,
} from "./github.js";
import { pollTrackingComment, expectSuccess, extractPrUrl } from "./poll.js";

const TRIGGER_PHRASE = "@e2e-agent";

async function main(): Promise<void> {
  const suffix = syntheticSuffix();
  const canaryFile = `e2e-canary-${suffix}.md`;

  const issue = await createSyntheticIssue({
    title: `[E2E] Thread-context regression ${suffix}`,
    body: "Something is broken, see title.",
  });
  writeOutput("issue_number", String(issue.number));
  console.log(`Created issue ${issue.url}`);

  await commentOnIssue(
    issue.number,
    `The actual repro: the fix is to add an empty file named \`${canaryFile}\` at the repo root.`,
  );
  await commentOnIssue(
    issue.number,
    `${TRIGGER_PHRASE} address the issue above using the latest information in this thread.`,
  );

  const { owner, repo } = currentRepo();
  const result = await pollTrackingComment({ owner, repo, issue: issue.number });
  console.log(`Tracking comment reached state: ${result.state}`);
  expectSuccess(result, "thread-context scenario");

  const prUrl = extractPrUrl(result.body);
  writeOutput("pr_url", prUrl);
  console.log(`Resulting PR: ${prUrl}`);

  const files = await prFilePaths(prUrl);
  console.log(`PR files: ${files.join(", ") || "(none)"}`);
  if (!files.includes(canaryFile)) {
    throw new Error(
      `expected the PR to include the canary file "${canaryFile}" (only mentioned in the ` +
        `follow-up comment, not the issue body or the trigger comment) — the agent did not ` +
        `pick it up from thread context. PR files: ${files.join(", ") || "(none)"}`,
    );
  }
  console.log("PASS: thread-context regression");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
