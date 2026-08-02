---
type: Guide
title: Testing
description: Testing strategy for deep-agent-action — unit tests, CI pipeline, live E2E harness with real GitHub events, smoke check for provider imports, and the result validator.
tags: [testing, ci, e2e, smoke, unit-tests]
---

# Testing

The project has two testing layers: fast unit tests (no network) and a live E2E harness that exercises the action against real GitHub events with a real model.

## Unit Tests

- **Runner:** Bun's built-in test runner (`bun test`).
- **Location:** One `*.test.ts` per module under `test/`.
- **No network:** All tests are pure; no API calls, no model calls.
- **Pattern:** Extract pure functions and test those (see `normalizeModel`, `checkContainsTrigger`, `evaluateCommand`, `estimateCostUsd`, `parseFindings`).

### Test files by module:

| Test file                  | Module under test              | Key assertions                                                               |
| -------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| `config.test.ts`           | `src/config.ts`                | Input parsing, model normalization, merge precedence, deny-list immutability |
| `repoConfig.test.ts`       | `src/config/repoConfig.ts`     | YAML loading, Zod validation, snake_case→camelCase, best-effort failure      |
| `detector.test.ts`         | `src/modes/detector.ts`        | Mode detection per event type, trigger phrase matching, resume detection     |
| `triage.test.ts`           | `src/modes/triage.ts`          | Triage classification, label filtering, instruction resolution               |
| `comments.test.ts`         | `src/github/comments.ts`       | Tracking comment rendering, truncation, status parsing                       |
| `thread.test.ts`           | `src/github/thread.ts`         | Thread context rendering, tracking comment detection                         |
| `memory.test.ts`           | `src/github/memory.ts`         | Memory parse/append/render, turn capping, resume note                        |
| `ops.test.ts`              | `src/github/ops.ts`            | Branch name generation, git error explanation                                |
| `graphqlCommit.test.ts`    | `src/github/graphqlCommit.ts`  | Porcelain status parsing, changeset computation                              |
| `review.test.ts`           | `src/github/review.ts`         | Finding parsing, suggestion application, partition                           |
| `context.test.ts`          | `src/github/context.ts`        | Event payload normalization                                                  |
| `fork.test.ts`             | `src/github/fork.ts`           | Fork detection, allow-label gating                                           |
| `stream.test.ts`           | `src/agent/stream.ts`          | Activity tracking, todo mapping, budget/timeout/stall handling               |
| `budget.test.ts`           | `src/agent/budget.ts`          | Token usage extraction, budget evaluation                                    |
| `cost.test.ts`             | `src/agent/cost.ts`            | Price estimation, budget verdict                                             |
| `shellGuard.test.ts`       | `src/agent/shellGuard.ts`      | Command evaluation, operator splitting, `$(...)` detection                   |
| `env.test.ts`              | `src/agent/env.ts`             | Allow-list env, secret exclusion                                             |
| `prompt.test.ts`           | `src/agent/prompt.ts`          | System prompt, user message, review prompt                                   |
| `deepagentsConfig.test.ts` | `src/agent/policy.ts`          | Profile, repository guidance, and filesystem-permission security floor       |
| `sandbox.test.ts`          | VirtualMode sandboxing         | Filesystem tool scoping                                                      |
| `actor.test.ts`            | Actor validation               | Bot detection                                                                |
| `permissions.test.ts`      | Permission check               | Write/admin gating                                                           |
| `trigger.test.ts`          | Trigger extraction             | Instruction extraction from text                                             |
| `text.test.ts`             | `src/github/text.ts`           | Body truncation                                                              |
| `live-poll.test.ts`        | `scripts/e2e/live/poll.ts`     | Polling logic                                                                |
| `assertResult.test.ts`     | `scripts/e2e/assert-result.ts` | Result validation                                                            |
| `mockContext.ts`           | Test helper                    | Shared mock `GitHubContext`                                                  |

## CI Pipeline (`.github/workflows/ci.yml`)

Runs on every push to `main` and all PRs:

1. **`bun install --frozen-lockfile`**
2. **`bun run typecheck`** — `tsc --noEmit` (strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
3. **`bun run format:check`** — Prettier check (CI gate)
4. **`bun test`** — all unit tests
5. **`bun run smoke`** — `DEEP_AGENT_SMOKE=1 bun run src/index.ts` — instantiates every provider model and exits without any network call

### The Smoke Check

The smoke check is **not optional**. It exists to catch the one class of bug that source-run unit tests cannot: provider packages failing to load at runtime. The `smokeCheck()` function in `src/index.ts` constructs a model instance for each provider (anthropic, openai, google, openrouter) and builds an agent, proving the bundle can load all provider packages. Run it after touching dependencies or `src/agent/model.ts`.

## Live E2E Harness

### `.github/workflows/e2e.yml` — Main E2E

Drives the action as shipped against this repo with a real model and real GitHub API. Runs manually and nightly. Three serialized jobs (shared branch name + artifact name):

| Job             | What it tests                                | Assertions                                                                            |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `implement`     | `workflow_dispatch` + prompt opens a real PR | `status=success`, `pr_url` non-empty, `result_json` well-formed, audit artifact valid |
| `approval-gate` | `require_push_approval: true`                | Draft PR with `approvalPending=true`                                                  |
| `budget-cap`    | `max_total_tokens: "50"`                     | `budget_stopped=true`, partial work lands as draft                                    |

Each job cleans up its PR on completion. All jobs are serialized because they share a branch name and artifact name.

### `.github/workflows/e2e-live-*.yml` — Dogfood Harness

A separate dogfood harness that exercises real issue/PR trigger paths with live GitHub events. Uses an OpenRouter model (`deepseek-v4-flash`).

**Orchestrator** (`e2e-live-orchestrator.yml`): triggers scenario workflows and polls for completion.

**Event workflows** (`e2e-live-events.yml`): listens for issue/PR events from the scenarios.

**Scenarios** (`scripts/e2e/live/`):

| Script                       | Scenario                                |
| ---------------------------- | --------------------------------------- |
| `scenario-auto-run.ts`       | Auto-run via label trigger              |
| `scenario-resume.ts`         | Resume an incomplete plan               |
| `scenario-review.ts`         | Code review on a PR                     |
| `scenario-thread-context.ts` | Agent receives full thread context      |
| `poll.ts`                    | Polls for scenario completion           |
| `cleanup.ts`                 | Cleans up after scenarios               |
| `github.ts`                  | Shared GitHub API helpers for scenarios |

### Result Validator (`scripts/e2e/assert-result.ts`)

Validates the `result_json` (`RunRecord`) emitted by the action. Used by the E2E harness both via stdin and from the downloaded artifact file.

- **`validateResult()`** — structural validation: checks `status`, `mode`, `model`, `plan`, `toolCalls`, `filesChanged`, optional `tokens`, `costUsd`, `approvalPending`, `stopped`, and `activities`.
- **`assertResult()`** — adds optional `EXPECT_STATUS` env check.
- **CLI** — reads from file path or stdin; exits non-zero with an error list on failure.

## Local Development

```bash
bun install                    # install dependencies
bun run typecheck              # tsc --noEmit
bun test                      # all unit tests
bun test test/cost.test.ts    # a single test file
bun run format                # prettier --write
bun run format:check          # prettier --check (CI gate)
bun run smoke                 # provider import smoke check
```

Run all four (typecheck, format:check, test, smoke) before pushing — same as CI.

## Relationships

- Tests verify the [control plane](../architecture/overview.md) and [agent subsystem](../architecture/agent.md) modules.
- The E2E harness validates the full pipeline including [GitHub Operations](../architecture/github-ops.md).
- CI also enforces [security](security.md) properties (deny-list immutability, secret exclusion).
- See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full project layout and contribution guide.
