/**
 * Live regression test for resume/continue
 * (`src/modes/detector.ts::isResumeRequest`, seeded via `src/index.ts`'s
 * `resumeTodos`): runs a multi-step task on an issue carrying the
 * `e2e-resume-cap` label (which makes e2e-live-events.yml apply a small
 * `max_total_tokens`, so it stops before finishing), then comments "continue"
 * and asserts the new run's plan actually picks up the prior open todos
 * instead of starting over.
 *
 * Requires: e2e-live-events.yml already deployed on the default branch with
 * its `max_total_tokens` cap gated on the `e2e-resume-cap` label.
 *
 * CLI: bun run scripts/e2e/live/scenario-resume.ts
 */
import {
  createSyntheticIssue,
  commentOnIssue,
  currentRepo,
  syntheticSuffix,
  writeOutput,
} from "./github.js";
import { pollTrackingComment, expectSuccess } from "./poll.js";
import { parseMemory } from "../../../src/github/memory.js";

const TRIGGER_PHRASE = "@e2e-agent";

async function main(): Promise<void> {
  const suffix = syntheticSuffix();

  const issue = await createSyntheticIssue({
    title: `[E2E] Resume/continue scenario ${suffix}`,
    body: "Multi-step task for the resume-scenario harness; a follow-up comment will trigger it.",
    labels: ["e2e-resume-cap"],
  });
  writeOutput("issue_number", String(issue.number));
  console.log(`Created issue ${issue.url}`);

  // Turn 1: enough distinct, genuinely SEQUENTIAL steps to force multiple
  // model turns — a fast/cheap model can otherwise batch several independent
  // tool calls (e.g. 3 unrelated file writes) into one turn and finish before
  // a token cap is ever checked, leaving no open todos to resume (observed
  // live: 3 independent files completed in ~8.8k tokens under a 3000 cap).
  // Each file here must quote the previous file's name, which the model can
  // only know after that file's write has actually completed and been
  // observed — forcing a read-after-write dependency chain across turns.
  const files = ["a", "b", "c", "d", "e"].map((letter) => `e2e-resume-${suffix}-${letter}.md`);
  const steps = files
    .map((f, i) =>
      i === 0
        ? `1. ${f}: a one-line fact about a fruit.`
        : `${i + 1}. ${f}: a one-line fact about a different fruit, and it must also quote the ` +
          `exact filename from step ${i}.`,
    )
    .join("\n");
  await commentOnIssue(
    issue.number,
    `${TRIGGER_PHRASE} first call write_todos to create a plan with one item per file below. ` +
      "Then, strictly one at a time — write each file, then read it back to confirm before " +
      `starting the next — create:\n${steps}`,
  );

  const { owner, repo } = currentRepo();
  const turn1 = await pollTrackingComment({ owner, repo, issue: issue.number });
  console.log(`Turn 1 reached state: ${turn1.state}`);
  expectSuccess(turn1, "turn 1 (budget stops still land as success)");

  const turn1Memory = parseMemory(turn1.body);
  const openTodos = turn1Memory.at(-1)?.openTodos ?? [];
  console.log(`Turn 1 open todos: ${JSON.stringify(openTodos)}`);
  if (openTodos.length === 0) {
    throw new Error(
      "precondition failed: turn 1 left no open todos to resume — the configured " +
        "max_total_tokens cap is either too high (the task completed before stopping) " +
        "or too low (it stopped before a plan even formed). Tune it in e2e-live-events.yml " +
        "and re-run.",
    );
  }

  // Turn 2: "continue" should seed the prior open todos as the starting plan.
  await commentOnIssue(issue.number, `${TRIGGER_PHRASE} continue`);
  const turn2 = await pollTrackingComment({
    owner,
    repo,
    issue: issue.number,
    sinceUpdatedAt: turn1.updatedAt,
  });
  console.log(`Turn 2 reached state: ${turn2.state}`);
  expectSuccess(turn2, "turn 2");

  const carriedOver = openTodos.some((t) => turn2.body.includes(t.content));
  if (!carriedOver) {
    throw new Error(
      "expected turn 2's plan to carry over at least one of turn 1's open todos " +
        `(${JSON.stringify(openTodos.map((t) => t.content))}), but none appeared in:\n${turn2.body}`,
    );
  }
  console.log("PASS: resume/continue");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
