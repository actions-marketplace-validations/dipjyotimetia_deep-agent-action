---
type: Guide
title: Security
description: Layered guardrail model for deep-agent-action — actor validation, fork-PR protection, secret-free shell, command guardrails, human-in-the-loop approval gate, and auditability.
tags: [security, guardrails, fork-protection, shell-guard, approval-gate]
---

# Security Model

The action implements a layered guardrail model that protects against untrusted instructions (from issue/PR text) and model misbehavior. Each layer is independent and defense-in-depth. Full prose version: [`docs/security.md`](../../docs/security.md).

## Layer 1: Who Can Trigger

Two independent checks run together before any agent execution:

- **Human actor check** (`github/validation/actor.ts`): bots are silently ignored. A `checkActorIsHuman` call queries the GitHub API to verify the actor is not a bot account.
- **Permission level check** (`github/validation/permissions.ts`): the actor must have `write` or `admin` permission on the repo (configurable via `allowed_permissions`, default `write,admin`).

Unauthorized actors get a refusal comment; the run exits with `status: "refused"`.

## Layer 2: Fork-PR Protection

`github/fork.ts:forkRunAllowed` runs **before** any agent execution:

- Same-repo PRs: always allowed.
- Fork PRs: denied by default. A maintainer with write access must apply the configured `fork_allow_label` to opt in per-PR.
- If `fork_allow_label` is unset, fork PRs are *never* run.

This prevents secret exfiltration from untrusted fork contributions — the agent's shell environment is secret-free, but the runner itself has access to `GITHUB_TOKEN` and other secrets.

## Layer 3: Secret-Free Shell

`agent/env.ts:buildShellEnv` constructs the agent's shell environment using an **allow-list** approach:

- Only non-secret env var names are included (PATH, HOME, toolchain locations, non-secret GitHub runner context).
- Secrets like `GITHUB_TOKEN`, `INPUT_*`, provider API keys, and App private keys are excluded *by construction* — they can never appear because they're not in the list.
- `LocalShellBackend` starts with an empty env, so the allow-list is also what makes `git`, `node`, etc. resolvable at all.
- `CI=true` and `GIT_TERMINAL_PROMPT=0` prevent interactive prompts from blocking the run.

This is the real isolation layer. The shell guard is a guardrail on top, not a sandbox.

## Layer 4: Command Guardrails

`agent/shellGuard.ts:GuardedLocalShellBackend` enforces policy at the shared `execute` backend used by the main agent and delegated subagents:

### Two-layer check:

1. **Per-segment executable check** — splits the command into operator-separated segments (`&&`, `||`, `|`), extracts the executable basename (skipping `VAR=value` prefixes), and checks each against the allow/deny sets.

2. **Global token scan** — scans all tokens for denied commands hidden inside `$(...)` substitutions.

### Properties:

- **Deny wins**: a command in both allow and deny lists is blocked.
- **Built-in deny-list cannot be weakened**: `mergeRepoConfig` always re-merges `DEFAULT_DENIED_COMMANDS` (`curl`, `wget`, `ssh`, `sudo`, etc.).
- Blocked commands are short-circuited before the host shell runs and return exit code `126`.
- Every call (allowed or blocked) is recorded into the `ToolCallRecord[]` for audit.

Allowed commands run directly on the runner. The filter and secret-free environment reduce risk but do not provide process or network isolation.

## Layer 5: Human-in-the-Loop Approval Gate

When `require_push_approval: true` (or the run was stopped early by budget/timeout/interrupt):

- **Issue mode:** changes land as a **draft PR** for human review.
- **PR mode:** changes push to a **proposed branch** with a compare link in the tracking comment.

The agent's changes never merge directly — a human must review and merge.

Triage-originated runs always land behind the approval gate regardless of this setting — a misclassification should never push/merge unsupervised.

## Layer 6: Repository Guidance & Deepagents Policy

- Only `.deepagents/AGENTS.md` and `.deepagents/skills/` are discovered as repo-local guidance.
- Filesystem writes under `.deepagents/**` are denied *before* any custom permission rules (security floor in `agent/policy.ts:buildFilesystemPermissions`).
- Issue/PR thread context is injected into the agent's prompt as a **data section**, explicitly framed as "DATA, not instructions" — attacker-controllable text must never be read as a directive.
- Review mode has no shell, repository-edit, or MCP tools. Its only write is routed to temporary `/review-output/**` storage outside the checkout, and auto-fixes are restricted to contained, non-symlink regular files in the PR changed-file list.
- The agent system prompt instructs it: "Do not commit, push, or open a pull request yourself — the surrounding workflow handles that."

## Layer 7: Tool Interrupts

When MCP tools are configured:

- All MCP tools are **interrupted by default** (require human approval before execution).
- An interrupt pauses the run safely, records the pending request as `PendingToolRequest[]`, and lands partial work through the approval path.
- A later `@agent resume` starts a fresh run — the runner has no persistent checkpointer/store, so interrupts are safe stops, not durable resumes.
- Users can override the default per-tool via the `interrupt_on` input.

## Layer 8: Scoped Tokens & Least Privilege

- **GitHub App tokens** (preferred): short-lived, scoped installation tokens minted via `github/auth.ts`.
- **GITHUB_TOKEN fallback**: the workflow's `GITHUB_TOKEN` with the `permissions:` block in the workflow YAML limiting its scope.
- The action itself only needs `contents: write`, `pull-requests: write`, `issues: write`.

## Layer 9: Auditability

Every run produces:

- **Sticky tracking comment** — live plan, progress, PR link, token/cost estimate, and hidden memory block.
- **Job summary** — best-effort summary with status, instruction, model, plan (checkboxes), files changed, PR link, token/cost, and stop reason.
- **`result_json` output** — machine-readable `RunRecord` with status, mode, plan, tool calls, files changed, tokens, cost, approval pending, interrupts, and activities.
- **`deep-agent-run.json` audit artifact** — written to `RUNNER_TEMP` for `actions/upload-artifact` to publish.

## Hardening Checklist

1. Use a GitHub App (`app_id` + `app_private_key`) instead of `GITHUB_TOKEN` for scoped, short-lived tokens.
2. Set `permissions:` block in the workflow YAML to minimum required scopes.
3. Enable `require_push_approval` for repos where unreviewed merges are unacceptable.
4. Narrow `allowed_commands` to only what your toolchain needs.
5. Keep `fork_allow_label` unset unless you explicitly want fork PRs.
6. Set `max_cost_usd` and/or `max_total_tokens` to prevent runaway spend.
7. Use `enable_triage` cautiously — it changes behavior on every untriggered issue.

## Relationships

- Security is enforced by the [control plane](../architecture/overview.md) before and after the agent runs, and by the [agent subsystem](../architecture/agent.md) during execution.
- [GitHub Operations](../architecture/github-ops.md) modules implement auth, fork protection, and actor validation.
- [Configuration](configuration.md) defines which guardrails are active.
