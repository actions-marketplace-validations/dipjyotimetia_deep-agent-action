---
type: Reference
title: Source Map
description: Concise map of all source files in deep-agent-action with one-line descriptions, organized by directory.
tags: [source-map, reference, file-map]
---

# Source Map

A concise map of every source file in the repository, organized by directory. Use this for navigation when making changes.

## Root

| File | Purpose |
|---|---|
| `action.yml` | Composite action declaration: all inputs, defaults, and the Bun runtime config. |
| `package.json` | Dependencies, scripts (`typecheck`, `test`, `smoke`, `format`), and project metadata. |
| `tsconfig.json` | TypeScript config: ES2022 target, ESNext module, strict mode, `verbatimModuleSyntax`. |
| `bun.lock` | Bun lockfile. |
| `.prettierrc.json` | Prettier formatting config. |
| `README.md` | Full user-facing documentation: features, quickstart, inputs, usage modes, security. |
| `CONTRIBUTING.md` | Dev setup, project layout, testing strategy, and how to make common changes. |
| `CLAUDE.md` | Guidance for Claude Code when working in this repository. |
| `SECURITY.md` | Security policy. |
| `LICENSE` | MIT license. |

## `src/` — Entry point and core types

| File | Purpose |
|---|---|
| `index.ts` | The main entry point. `run()` is the 9-step control-plane pipeline; `runImplement` and `runReview` are the two agent flows. Also contains `smokeCheck()` for the smoke test. |
| `types.ts` | Shared types: `GitHubContext`, `Config`, `Mode`, `RunRecord`, `RunStatus`, `StopReason`, `TokenUsage`, `ToolCallRecord`. |
| `config.ts` | Action input parsing (`loadConfig`), model normalization (`normalizeModel`), config merge (`mergeRepoConfig`), provider key resolution. Defines `DEFAULT_ALLOWED_COMMANDS` and `DEFAULT_DENIED_COMMANDS`. |
| `outputs.ts` | Emits GitHub Action outputs (`emitOutputs`), job summary (`writeSummary`), and audit artifact (`writeAuditRecord`). |

## `src/agent/` — Agent subsystem

| File | Purpose |
|---|---|
| `createAgent.ts` | Assembles mode-aware agents: guarded shell backend, structured system prompt, filesystem middleware/tools, permissions, review-output route, and implement-mode MCP tools. |
| `model.ts` | Multi-provider model factory (`createModel`). Static imports for all 8 LangChain provider classes. |
| `stream.ts` | Streaming agent driver (`runAgentStream`). Progress mirroring, activity tracking, budget/timeout abort, interrupt extraction. |
| `prompt.ts` | System and user prompt builders: `buildSystemPrompt`, `buildUserMessage`, `buildReviewSystemPrompt`, `buildReviewUserMessage`. |
| `budget.ts` | `BudgetMeter` (BaseCallbackHandler) for cumulative token metering across subagents. `usageFromLLMResult` extracts token counts. |
| `cost.ts` | `estimateCostUsd` (substring-matched price table) and `evaluateBudget` (pure budget verdict). |
| `env.ts` | `buildShellEnv` — secret-free allow-list environment for the agent's shell. |
| `shellGuard.ts` | `GuardedLocalShellBackend` — shared main/subagent command allow/deny enforcement and audit, with per-segment and global token scans. |
| `mcp.ts` | `loadMcpTools` — best-effort MCP server tool loader. Returns empty handle on failure. |
| `policy.ts` | Parses/validates harness profiles, filesystem permissions, and interrupt policies. Discovers `.deepagents/` sources. Builds security-floor permissions. |

## `src/config/` — Per-repo config

| File | Purpose |
|---|---|
| `repoConfig.ts` | Loads and validates `.github/deep-agent.yml` via Zod with per-field `.catch()`. `RepoConfig` interface, `loadRepoConfig()`, `normalizeRepoConfig()`. |

## `src/github/` — GitHub operations

| File | Purpose |
|---|---|
| `context.ts` | `parseContext` — normalizes webhook payload into `GitHubContext`. |
| `auth.ts` | `resolveToken` — mints GitHub App installation token or falls back to `GITHUB_TOKEN`. |
| `client.ts` | `makeOctokit` — authenticated Octokit with retry hook. `githubServerUrl` for GHES support. |
| `comments.ts` | Sticky tracking comment lifecycle: find/create/update, `renderTrackingBody`, `truncateTrackingBody`, `addEyesReaction`. |
| `thread.ts` | `fetchThread` — fetches issue/PR title, body, and comments; locates tracking comment. |
| `memory.ts` | Cross-run memory: `parseMemory`, `appendTurn`, `renderMemoryBlock`, `buildMemoryContext`. Base64-encoded hidden HTML comment. |
| `ops.ts` | Git operations and change landing: `runGit`, `generateBranchName`, `checkoutPrHead`, `landChanges`, `resolveBotIdentity`. |
| `graphqlCommit.ts` | Verified commits via `createCommitOnBranch` GraphQL mutation. `landChangesVerified`, `computeChangeset`, `parsePorcelainStatus`. |
| `review.ts` | Code review parsing/posting, isolated handoff constants, and changed-file/containment/symlink-safe suggestion application. |
| `fork.ts` | `forkRunAllowed` — fork-PR protection gating. |
| `text.ts` | `truncateBody` utility for GitHub character limits. |

## `src/github/validation/` — Actor and trigger validation

| File | Purpose |
|---|---|
| `actor.ts` | `checkActorIsHuman` — rejects bot actors. |
| `permissions.ts` | `checkActorPermission` — verifies write/admin permission level. |
| `trigger.ts` | `extractInstruction` — extracts instruction text from trigger text. |

## `src/modes/` — Mode detection and triage

| File | Purpose |
|---|---|
| `detector.ts` | `detectMode` — routes event to `agent`/`review`/`noop`. `isReviewRequest`, `isReviewAndFixRequest`, `isResumeRequest`. |
| `triage.ts` | `runTriageCheck` — one-shot LLM classification of new issues. `classifyIssue`, `TriageHandoff`, `filterAllowedLabels`. |

## `test/` — Unit tests

One `*.test.ts` per module. See the [Testing guide](../guides/testing.md) for the full list.

## `scripts/e2e/` — E2E harness scripts

| File | Purpose |
|---|---|
| `assert-result.ts` | Validates `result_json` (RunRecord) from the E2E harness. |
| `live/github.ts` | Shared GitHub API helpers for live scenarios. |
| `live/poll.ts` | Polls for scenario completion. |
| `live/cleanup.ts` | Cleans up after scenarios. |
| `live/scenario-auto-run.ts` | Auto-run via label trigger scenario. |
| `live/scenario-resume.ts` | Resume incomplete plan scenario. |
| `live/scenario-review.ts` | Code review scenario. |
| `live/scenario-thread-context.ts` | Full thread context scenario. |

## `.github/workflows/` — CI and E2E workflows

| File | Purpose |
|---|---|
| `ci.yml` | CI: typecheck → format:check → test → smoke. |
| `e2e.yml` | Live E2E: implement, approval-gate, budget-cap jobs. |
| `e2e-live-events.yml` | Dogfood harness event listener. |
| `e2e-live-orchestrator.yml` | Dogfood harness orchestrator. |
| `demo.yml` | Demo workflow for manual tryout. |
| `openwiki-update.yml` | Scheduled OpenWiki documentation refresh. |

## `docs/` — User documentation

| File | Purpose |
|---|---|
| `configuration.md` | Complete configuration reference (inputs, env vars, per-repo config). |
| `providers.md` | Model providers reference (8 providers, credential chains, examples). |
| `security.md` | Security model (9 sections + hardening checklist). |
| `troubleshooting.md` | Common issues and fixes (Q&A format). |
| `feature-review.md` | Feature review notes. |
| `demo.md` | Demo walkthrough and sample output. |

## `examples/` — Ready-to-use workflow examples

| File | Purpose |
|---|---|
| `README.md` | Index of all examples. |
| `agent.yml` | All-in-one workflow with inline comments. |
| `review.yml` | Read-only code review mode. |
| `approval-gate.yml` | Human-in-the-loop approval gate. |
| `multi-provider.yml` | Multiple model providers. |
| `mcp-tools.yml` | MCP tool servers. |
| `github-app.yml` | GitHub App authentication. |
| `fork-support.yml` | Fork PR support. |
| `issue-automation.yml` | Issue automation via label/assignee. |
| `scheduled-maintenance.yml` | Scheduled maintenance runs. |

## Relationships

- The [Architecture Overview](../architecture/overview.md) explains how these files interact in the control-plane pipeline.
- The [Agent Subsystem](../architecture/agent.md) page details the `src/agent/` modules.
- The [GitHub Operations](../architecture/github-ops.md) page details the `src/github/` modules.
- The [Testing](../guides/testing.md) page maps test files to their source modules.
