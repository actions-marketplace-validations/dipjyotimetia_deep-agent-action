/**
 * Live regression test for review mode. `CONTRIBUTING.md` previously noted
 * this had zero live coverage, since GitHub won't let a runner fake a
 * PR-attached event on `workflow_dispatch`. This pushes a branch with one
 * deliberate bug, opens a real PR, comments "@e2e-agent review" on it, and
 * asserts the action actually posted a PR review.
 *
 * Requires: e2e-live-events.yml already deployed on the default branch, and
 * the job's checkout to have push credentials for the current repo (the
 * default `actions/checkout` behavior).
 *
 * CLI: bun run scripts/e2e/live/scenario-review.ts
 */
import {
  runCmd,
  createSyntheticPr,
  commentOnPr,
  currentRepo,
  prReviewCount,
  syntheticSuffix,
  writeOutput,
} from "./github.js";
import { pollTrackingComment, expectSuccess } from "./poll.js";

const TRIGGER_PHRASE = "@e2e-agent";

const BUGGY_SNIPPET = `// Deliberately buggy: uses assignment instead of comparison.
export function isEven(n: number): boolean {
  let result;
  if ((result = n % 2) == 0) {
    return true;
  }
  return false;
}
`;

async function main(): Promise<void> {
  const suffix = syntheticSuffix();
  const branch = `e2e/review-${suffix}`;
  const file = `demo/e2e-review-${suffix}.ts`;

  await runCmd(["git", "checkout", "-b", branch]);
  await Bun.write(file, BUGGY_SNIPPET);
  await runCmd(["git", "add", file]);
  await runCmd([
    "git",
    "-c",
    "user.email=e2e@deep-agent-action",
    "-c",
    "user.name=deep-agent-e2e",
    "commit",
    "-m",
    `e2e: add deliberately buggy file for review scenario ${suffix}`,
  ]);
  await runCmd(["git", "push", "origin", branch]);

  const pr = await createSyntheticPr({
    branch,
    title: `[E2E] Review-mode scenario ${suffix}`,
    body: "Synthetic PR for the live review-mode harness. Safe to close.",
  });
  writeOutput("pr_url", pr.url);
  console.log(`Created PR ${pr.url}`);

  await commentOnPr(pr.url, `${TRIGGER_PHRASE} review`);

  const { owner, repo } = currentRepo();
  const result = await pollTrackingComment({ owner, repo, issue: pr.number });
  console.log(`Tracking comment reached state: ${result.state}`);
  expectSuccess(result, "review scenario");

  const reviewCount = await prReviewCount(pr.number);
  console.log(`PR review count: ${reviewCount}`);
  if (reviewCount < 1) {
    throw new Error(`expected at least one PR review to be posted, got ${reviewCount}`);
  }
  console.log("PASS: review mode");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
