/**
 * Live regression test for resume/continue
 * (`src/modes/detector.ts::isResumeRequest`, seeded via `src/index.ts`'s
 * `resumeTodos`): runs a multi-step task on an issue carrying the
 * `e2e-resume-cap` label (routed by e2e-live-events.yml to a job variant with
 * a small `max_total_tokens`, so it stops before finishing), then comments
 * "continue" and asserts the new run's plan actually picks up the prior
 * open todos instead of starting over.
 *
 * Requires: e2e-live-events.yml already deployed on the default branch with
 * its capped job variant gated on the `e2e-resume-cap` label.
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
import { pollTrackingComment } from "./poll.js";
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

  // Turn 1: a task with enough distinct steps to force a multi-item plan,
  // deliberately run under a tight max_total_tokens (see e2e-live-events.yml's
  // "agent-capped" job variant) so it stops before finishing all of them.
  await commentOnIssue(
    issue.number,
    `${TRIGGER_PHRASE} create three files at the repo root, one at a time: ` +
      `e2e-resume-${suffix}-a.md, e2e-resume-${suffix}-b.md, and e2e-resume-${suffix}-c.md, ` +
      "each with a one-line description of a different fruit.",
  );

  const { owner, repo } = currentRepo();
  const turn1 = await pollTrackingComment({ owner, repo, issue: issue.number });
  console.log(`Turn 1 reached state: ${turn1.state}`);
  if (turn1.state !== "success") {
    throw new Error(
      `expected turn 1 state=success (budget stops still land), got ${turn1.state}\n${turn1.body}`,
    );
  }

  const turn1Memory = parseMemory(turn1.body);
  const openTodos = turn1Memory.at(-1)?.openTodos ?? [];
  console.log(`Turn 1 open todos: ${JSON.stringify(openTodos)}`);
  if (openTodos.length === 0) {
    throw new Error(
      "precondition failed: turn 1 left no open todos to resume — the configured " +
        "max_total_tokens cap on the 'agent-capped' job variant is either too high " +
        "(the task completed before stopping) or too low (it stopped before a plan " +
        "even formed). Tune it in e2e-live-events.yml and re-run.",
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
  if (turn2.state !== "success") {
    throw new Error(`expected turn 2 state=success, got ${turn2.state}\n${turn2.body}`);
  }

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
