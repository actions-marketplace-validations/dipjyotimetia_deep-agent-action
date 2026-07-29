---
type: Architecture
title: Architecture Overview
description: The 9-step control-plane pipeline in src/index.ts, agent assembly, review-mode handoff, and the critical constraints that are easy to break.
tags: [architecture, control-plane, pipeline, constraints]
---

# Architecture Overview

The action's core is a single linear orchestration function (`run()` in `src/index.ts`) that sandwiches an AI agent between a pre-execution gating phase and a post-execution landing phase. The control plane — not the model — handles all GitHub operations, git commands, and security enforcement.

## 9-Step Control-Plane Pipeline

1. **Parse** the webhook event into a normalized `GitHubContext` (`github/context.ts`). Supported events: `issue_comment`, `pull_request_review_comment`, `issues`, `pull_request`, `workflow_dispatch`.

2. **Config merge** — action inputs are loaded via `config.ts:loadConfig`, then an optional per-repo `.github/deep-agent.yml` is loaded via `config/repoConfig.ts` and overlaid with `mergeRepoConfig`. The built-in deny-list is always re-merged so repo config can never weaken it.

3. **Route** — `modes/detector.ts:detectMode` decides `agent`, `review`, or `noop`. No trigger phrase and no explicit prompt → `noop` → exit with no side effects. When triage is enabled and the event is a new issue with no trigger, a one-shot LLM call classifies it before giving up.

4. **Token** — `github/auth.ts:resolveToken` mints a scoped, short-lived GitHub App installation token (when `app_id` + `app_private_key` are configured), falling back to `GITHUB_TOKEN`. The token source (`"app"` | `"github_token"`) determines commit identity and whether verified commits are available.

5. **Gate** — two independent checks run together:
   - **Fork-PR protection** (`github/fork.ts`): fork PRs are denied by default unless a maintainer applied the configured `fork_allow_label`.
   - **Authorization** (`github/validation/`): the actor must be human (bots are silently ignored) AND have `write` or `admin` permission. Unauthorized actors get a refusal comment.

6. **Acknowledge** — a 👀 reaction is added to the triggering comment/issue, the full issue/PR thread is fetched (`github/thread.ts`), and MCP tools are loaded (`agent/mcp.ts`) — all in parallel. The sticky tracking comment is found or created (`github/comments.ts`). Cross-run memory is parsed from the existing comment body (`github/memory.ts`).

7. **Run** — the agent is assembled (`agent/createAgent.ts:buildAgent`) and driven via LangGraph streaming (`agent/stream.ts:runAgentStream`):
   - **Agent mode** (`runImplement`): the model plans, edits files, and runs shell commands in the workspace. Progress is mirrored to the tracking comment.
   - **Review mode** (`runReview`): the model reads the PR diff, writes findings to a JSON file, and the control plane posts them as inline review comments.

8. **Land** — `github/ops.ts:landChanges` commits and pushes changes, then reuses or creates a PR. When `require_push_approval` is set (or the run was stopped early by budget/timeout/interrupt), changes land as a draft PR or proposed branch. When `verified_commits` is set, `github/graphqlCommit.ts:landChangesVerified` commits via the `createCommitOnBranch` GraphQL mutation instead. In review mode, `github/review.ts:postReview` posts inline comments, and optionally `applyReviewSuggestions` patches files on disk when `review and fix` or `apply_suggestions` is active.

9. **Finalize** — the tracking comment is updated with the final status, PR link, token/cost summary, and appended memory turn. `outputs.ts:emitOutputs` writes GitHub Action outputs (`status`, `pr_url`, `branch`, `result_json`, etc.), a job summary, and a `deep-agent-run.json` audit artifact to `RUNNER_TEMP`.

## Agent Assembly

`createAgent.ts:buildAgent` wires together:

- A guarded `LocalShellBackend` rooted at the workspace with `virtualMode: true`. Filesystem tools are contained to the repo; allowed commands execute directly on the runner and are policy-filtered at the backend shared by the main agent and subagents.
- A `CompositeBackend` wrapping the shell backend with a `/` route so filesystem permissions can be enforced.
- The LangChain model instance from `agent/model.ts` (static imports for all 8 providers).
- Repository-local deepagents memory (`.deepagents/AGENTS.md`) and skills (`.deepagents/skills/`), discovered by `agent/policy.ts`.
- Validated filesystem permission rules (with a security-floor deny-write for `/.deepagents/**`).
- Tool interrupt policy (MCP tools interrupted by default).
- A mode-specific `FilesystemMiddleware` tool allowlist: all filesystem tools in implement mode; read/search plus the isolated review-output write in review mode.
- Any MCP tools loaded from the `mcp_config` input in implement mode.
- A `MemorySaver` checkpointer (only when interrupts are configured, since LangGraph requires it for the interrupt primitive).

The assembled agent is driven by `stream.ts:runAgentStream`, which uses `streamMode: "values"` with `subgraphs: true` to track plan/progress from both the main agent and subagents. See the [Agent Subsystem](agent.md) page for full details.

## Review-Mode Handoff

In review mode, the agent receives the PR diff and can read/search the checkout, but it has no repository edit, shell, or MCP tools. It writes findings to `/review-output/findings.json`, routed by `CompositeBackend` to temporary storage outside the checkout. The control plane reads and removes that handoff, validates it with Zod, and posts inline comments. For "review and fix" (or `apply_suggestions`), suggestions are applied only when the path is in GitHub's changed-file list, resolves inside the checkout, names a non-symlink regular file, and still has the requested line; rejected suggestions remain comments.

Editing review behavior usually means touching both the review system prompt (`agent/prompt.ts:buildReviewSystemPrompt`) and `github/review.ts`.

## Critical Constraints

These are the easy things to break. They are enforced by code and tested, but changes that violate them will cause subtle runtime failures.

1. **Static model imports are mandatory.** `agent/model.ts` constructs each LangChain chat model with a *static* import. Do not refactor to pass a `"provider:model"` string — that path uses LangChain's dynamic `import()`, which fails to resolve at runtime. The smoke check guards this.

2. **The agent shell is secret-free by construction.** `agent/env.ts` is an *allow-list* of env var names; provider keys, `GITHUB_TOKEN`, App keys, and `INPUT_*` are excluded. Don't add secret-bearing names to the list.

3. **The built-in command deny-list cannot be weakened.** `mergeRepoConfig` always re-merges `DEFAULT_DENIED_COMMANDS` (`curl`, `wget`, `ssh`, `sudo`, etc.), so a committed repo config can narrow the allow-list and add denials but never remove a default denial.

4. **The agent never runs git/push.** It only edits files in the workspace; all commit/branch/push/PR operations live in `github/ops.ts` and run with the scoped token via `execFileSync("git", ...)` (no shell — injection-safe).

5. **Deepagents repository guidance is intentionally narrow.** Only `.deepagents/AGENTS.md` and `.deepagents/skills/` are discovered. Filesystem writes under `.deepagents/` are denied before custom permission rules. Issue/PR text stays in a separate user-message data section, framed as untrusted data.

6. **ESM with explicit `.js` import extensions.** Source is `.ts` but imports use `.js` (e.g. `from "./config.js"`). Keep this when adding imports.

7. **Interrupts are safe stops, not durable resumes.** MCP tools are interrupted by default. The action records pending requests, lands partial work through the approval path, and a later `@agent resume` starts a fresh run using sticky-comment memory (no persistent checkpointer/store).

## Triage Mode (Opt-In)

When `enable_triage: true` is configured, a new issue with no trigger phrase is classified by a one-shot LLM structured-output call (`modes/triage.ts`). The classifier decides: open a PR, request a review, ask for clarification, add labels, or do nothing. Triage never lowers the authorization bar — the issue author must pass the same human + write/admin checks. Triage-originated runs always land behind the approval gate. Explicit triggers always win over triage.

## Relationship to Other Pages

- The [Agent Subsystem](agent.md) page details model construction, agent assembly, the streaming driver, budget metering, and the shell guard.
- The [GitHub Operations](github-ops.md) page covers auth, the tracking comment lifecycle, cross-run memory, git ops, verified commits, and code review posting.
- The [Configuration](../guides/configuration.md) page documents all action inputs, env vars, and per-repo config.
- The [Security](../guides/security.md) page covers the layered guardrail model in depth.
