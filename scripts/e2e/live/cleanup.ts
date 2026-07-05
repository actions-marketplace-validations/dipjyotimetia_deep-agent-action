/**
 * Best-effort cleanup for a live-harness scenario: closes the synthetic PR (if
 * any, deleting its branch) and the synthetic issue. Run as a separate
 * `if: always()` workflow step so cleanup still happens even if the scenario
 * script's own assertions threw.
 *
 * CLI: bun run scripts/e2e/live/cleanup.ts [issueNumber] [prUrl]
 *      (falls back to ISSUE_NUMBER / PR_URL env vars when args are omitted)
 */
import { closeIssue, closePr } from "./github.js";

async function closeIfPresent(
  prArg: string | undefined,
  issueArg: string | undefined,
): Promise<void> {
  if (prArg) console.log(`Closing PR ${prArg} (deleting branch)...`);
  if (issueArg) console.log(`Closing issue #${issueArg}...`);
  // Independent, both best-effort (closePr/closeIssue already swallow errors).
  await Promise.all([
    prArg ? closePr(prArg) : Promise.resolve(),
    issueArg ? closeIssue(Number(issueArg)) : Promise.resolve(),
  ]);
}

async function main(): Promise<void> {
  const issueArg = process.argv[2] || process.env.ISSUE_NUMBER;
  const prArg = process.argv[3] || process.env.PR_URL;

  if (!prArg && !issueArg) {
    console.log("Nothing to clean up (no ISSUE_NUMBER/PR_URL provided).");
    return;
  }
  await closeIfPresent(prArg, issueArg);
}

main();
