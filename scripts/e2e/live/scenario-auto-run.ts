/**
 * Live regression test for label-based auto-run
 * (`src/modes/detector.ts::detectMode`'s `autoRunLabel` bypass): creates an
 * issue whose title/body contain the trigger phrase NOWHERE, applies the
 * configured auto-run label, and asserts the agent still ran (mode detection
 * bypassed the trigger-phrase check entirely) and produced the requested change.
 *
 * Requires: e2e-live-events.yml already deployed on the default branch with
 * `auto_run_label: "e2e-agent-autorun"` configured.
 *
 * CLI: bun run scripts/e2e/live/scenario-auto-run.ts
 */
import {
  createSyntheticIssue,
  addLabel,
  currentRepo,
  prFilePaths,
  syntheticSuffix,
  writeOutput,
} from "./github.js";
import { pollTrackingComment, expectSuccess, extractPrUrl } from "./poll.js";

const AUTO_RUN_LABEL = "e2e-agent-autorun";

async function main(): Promise<void> {
  const suffix = syntheticSuffix();
  const markerFile = `e2e-autorun-${suffix}.md`;

  // Deliberately no trigger phrase anywhere — this tests the bypass, not the phrase path.
  const issue = await createSyntheticIssue({
    title: `[E2E] Label auto-run scenario ${suffix}`,
    body:
      `Use the write_file tool to create an empty file named "${markerFile}" — a relative ` +
      "path from the repository root, not an absolute filesystem path.",
  });
  writeOutput("issue_number", String(issue.number));
  console.log(`Created issue ${issue.url}`);

  await addLabel(issue.number, AUTO_RUN_LABEL);
  console.log(`Applied label "${AUTO_RUN_LABEL}"`);

  const { owner, repo } = currentRepo();
  const result = await pollTrackingComment({ owner, repo, issue: issue.number });
  console.log(`Tracking comment reached state: ${result.state}`);
  expectSuccess(result, "auto-run scenario (the agent should have run despite no trigger phrase)");

  const prUrl = extractPrUrl(result.body);
  writeOutput("pr_url", prUrl);
  console.log(`Resulting PR: ${prUrl}`);

  const files = await prFilePaths(prUrl);
  console.log(`PR files: ${files.join(", ") || "(none)"}`);
  if (!files.includes(markerFile)) {
    throw new Error(
      `expected the PR to include "${markerFile}". PR files: ${files.join(", ") || "(none)"}`,
    );
  }
  console.log("PASS: label auto-run");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
