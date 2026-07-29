---
type: Architecture
title: GitHub Operations
description: Auth, Octokit client, tracking comment lifecycle, thread context, cross-run memory, git ops, verified commits via GraphQL, and code review posting.
tags: [github, auth, comments, memory, git-ops, review, graphql]
---

# GitHub Operations

The `src/github/` module group handles all GitHub API interactions, git operations, and change landing. The agent itself never calls these — the control plane (`src/index.ts`) orchestrates them before and after the agent runs.

## Event Normalization (`context.ts`)

`parseContext(raw)` transforms the raw GitHub Actions webhook payload into a typed `GitHubContext` object (defined in `src/types.ts`). It determines:

- Whether the event is attached to a PR (`isPR`)
- The issue/PR number (`entityNumber`)
- The trigger text (comment/issue/PR body)
- Fork repo info (`prHeadRepoFullName`, `prBaseRepoFullName`, `prHeadRef`)
- Labels and event-specific label/assignee
- Whether it's a PR review comment

This `GitHubContext` flows through every other GitHub module.

## Token Resolution (`auth.ts`)

`resolveToken(params)` mints credentials for GitHub API access:

1. **GitHub App token** (preferred): creates a JWT from `app_id` + `app_private_key`, looks up the installation for the repo, and mints a scoped installation token. Short-lived and least-privilege.
2. **GITHUB_TOKEN fallback**: uses the workflow's `GITHUB_TOKEN` when no App is configured.

Returns `TokenResult` with the token, its source (`"app"` | `"github_token"`), and the app slug (used for commit identity). The token source also determines whether verified commits are available.

## Octokit Client (`client.ts`)

`makeOctokit(token)` creates an authenticated Octokit instance with a transient-failure retry hook:

- **Rate limits (429, 403 with retry-after):** retried for all methods.
- **5xx errors:** retried only for GET/HEAD (avoids duplicate mutations).
- `retryDelayMs(ctx)` is a pure function deciding whether to retry and for how long.
- `githubServerUrl()` returns the base GitHub URL (supports GHES deployments).

Every GitHub module that makes API calls receives an `Octokit` created here.

## Fork Protection (`fork.ts`)

`forkRunAllowed(ctx, forkAllowLabel)` returns `{ allowed, reason? }`:

- Same-repo PRs are always allowed.
- Fork PRs (or undetermined PRs) are allowed **only** if the configured `fork_allow_label` is present on the issue/PR.
- Otherwise denied with a human-readable reason.

This runs before any agent execution to prevent secret exfiltration from fork PRs.

## Actor Validation (`validation/`)

Three independent checks in `src/github/validation/`:

| Module | Check | Failure behavior |
|---|---|---|
| `actor.ts` | Is the actor a human (not a bot)? | Silently ignored — no comment. |
| `permissions.ts` | Does the actor have `write` or `admin`? | Refusal comment posted. |
| `trigger.ts` | Extract instruction from trigger text | Returns empty string if no instruction. |

## Tracking Comment Lifecycle (`comments.ts`)

The action maintains a single "sticky" tracking comment on each issue/PR — the agent's visible status board across runs.

- **`MARKER`** (`<!-- deep-agent:tracking -->`) — hidden HTML comment used to find the comment on re-runs.
- **`TrackingState`** — status, todos, PR URL, branch, tokens, cost, interrupts, activity, memory.
- **`renderTrackingBody(state)`** — renders the full comment body: status banner, plan checklist, PR link, pending approvals, activity, stop reason, token stats, and a hidden memory block.
- **`truncateTrackingBody(body)`** — clamps to GitHub's 65,536-char limit, preserving the trailing memory block.
- `findTrackingComment`, `createTrackingComment`, `updateTrackingComment` — CRUD via Octokit.
- `addEyesReaction` — best-effort 👀 reaction on the triggering comment/issue.

## Thread Context (`thread.ts`)

`fetchThread(octokit, ctx)` fetches the full issue/PR conversation (title, body, and recent comments) in a single pass. This gives the agent context beyond just the triggering comment.

- Locates the bot's sticky tracking comment (by `MARKER`).
- Renders prior human comments (excluding the triggering comment and the tracking comment) with per-comment and total-body character caps.
- Degrades to `{}` on any API failure.

The `trackingComment` returned is used to extract cross-run memory and to find the existing comment to update. The `context` string is injected into the agent's prompt as untrusted data.

## Cross-Run Memory (`memory.ts`)

A compact history of prior agent turns is stored as a hidden, base64-encoded HTML comment block inside the sticky tracking comment — no external backend needed.

- **`parseMemory(body)`** — extracts and decodes the memory block; defensive (`[]` on any error).
- **`extractMemoryBlock(body)`** — splits a comment body into `{ rest, block? }` so truncation can cut visible text without slicing through the memory block.
- **`renderMemoryBlock(turns)`** — base64-encodes the turn array into an HTML comment.
- **`appendTurn(turns, turn, opts)`** — appends a new turn, trims fields, caps open todos, clears stale plans from older turns, and keeps only the most recent 6 turns.
- **`buildMemoryContext(turns, opts)`** — renders the "Earlier on this thread" prompt section. When `resume` is set and the latest turn has open todos, appends a "resume incomplete plan" note. Explicitly fenced as **data, not instructions** to prevent prompt injection.

## Git Operations (`ops.ts`)

All local git operations and the "land changes" flow.

### Key exports:

- `runGit(args, cwd)` — shell-injection-safe git execution via `execFileSync("git", ...)` with token redaction in error messages.
- `sanitizeBranchName`, `generateBranchName` — deterministic branch names (`deep-agent/issue-12`, `deep-agent/pr-42`).
- `checkoutPrHead`, `checkoutIssueBranchIfExists` — fetch + checkout the correct branch before the agent runs.
- `configureGitIdentity`, `resolveBotIdentity` — set the bot's `user.name`/`user.email` from the app slug.
- `landChanges(params)` — the core landing pipeline: detect changes → commit → push (or proposed branch if approval-gated) → reuse or create a PR. Returns `LandResult`.
- `reuseExistingPr` — finds and reopens a non-merged PR for the same branch.
- `explainGitHubError(msg)` — augments known errors (protected branches, non-fast-forward, PR-creation denied) with actionable hints.

### Landing paths:

1. **PR mode:** push to the existing PR branch (or proposed branch + compare link when approval-gated).
2. **Issue mode with existing branch:** reuse the same branch/PR (continuity).
3. **Issue mode, new:** create a new branch, commit, push, and open a PR (or draft PR when approval-gated).

## Verified Commits (`graphqlCommit.ts`)

An alternative landing path that commits via GitHub's `createCommitOnBranch` GraphQL mutation, producing "Verified" commits.

- Requires GitHub App auth (`app_id` + `app_private_key`).
- Does not support file-mode/symlink changes (files always land as mode 100644).
- `parsePorcelainStatus(porcelain)` — classifies `git status --porcelain` output into additions/deletions.
- `computeChangeset(rootDir)` — reads changed files, base64-encodes additions.
- `ensureRefExists` — creates a branch ref if it doesn't exist (the GraphQL mutation requires a pre-existing ref).
- `landChangesVerified(params)` — the GraphQL analog of `ops.landChanges`, with the same three sub-paths but commits land via the mutation instead of `git push`.

Reuses many helpers from `ops.ts` (`commitTitle`, `generateBranchName`, `proposedBranchName`, `reuseExistingPr`, `explainGitHubError`, `buildPrBody`, `compareUrl`).

## Code Review (`review.ts`)

Parses agent-written review findings from a JSON file and posts them as inline PR review comments.

- **`REVIEW_FINDINGS_PATH`** (`/review-output/findings.json`) — the virtual handoff path routed to temporary storage outside the checkout.
- **`fetchPrFiles(octokit, ctx)`** — fetches changed files + patches for the PR.
- **`parseFindings(raw)`** — validates/coerces the agent's JSON via Zod (lenient: one bad element never discards the batch).
- **`formatFindingBody(f)`** — renders a finding's comment body with severity prefix and suggestion fence.
- **`applySuggestion(fileText, line, suggestion)`** — pure function, replaces a single line.
- **`partitionApplicableFindings`** — splits findings into auto-applicable (has suggestion + valid line) and unhandled.
- **`applyReviewSuggestions(rootDir, findings, changedFiles)`** — applies valid suggestions highest-line-first only to contained, non-symlink regular files present in the PR changed-file set; unsafe or stale suggestions remain unhandled.
- **`postReview(octokit, ctx, result)`** — posts a PR review with inline comments; falls back to a folded summary if inline comments are rejected by GitHub.

## Utility (`text.ts`)

`truncateBody(text, maxChars)` and `GITHUB_COMMENT_MAX_CHARS` — used by `comments.ts`, `ops.ts`, `review.ts`, and `graphqlCommit.ts` to respect GitHub's character limits.

## Relationships

- These modules are orchestrated by the [control plane](overview.md) in `src/index.ts`.
- The [agent subsystem](agent.md) produces the file changes and review findings that these modules land.
- Fork protection and actor validation are part of the [security model](../guides/security.md).
