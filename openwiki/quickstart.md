---
type: Reference
title: Deep Agent Action — Quickstart
description: Entry point for the deep-agent-action code wiki. Covers what the action does, how to set it up, and links to architecture, configuration, security, testing, and source-map pages.
tags: [quickstart, overview, entrypoint]
---

# Deep Agent Action — Code Wiki

**deep-agent-action** is a composite GitHub Action that runs an AI coding agent in-process on the runner. Mention `@agent` on an issue or PR and it plans, edits files, runs your toolchain, and opens a pull request. Comment `@agent review` on a PR and it posts an inline code review. No hosted service, no extra infrastructure — the agent runs entirely inside your GitHub Actions runner using a model provider of your choice.

The agent itself is the [`deepagents`](https://www.npmjs.com/package/deepagents) JS harness built on LangChain/LangGraph. The action wraps it with a control plane that handles event routing, authorization, progress tracking, change landing, and security guardrails.

## Key Features

- **In-runner agent** — plans, reads/edits files, runs shell commands, commits, opens a PR. No external service.
- **`@agent` triggers** — works from issue comments, PR comments, PR review comments, new issues, new PRs, and `workflow_dispatch`.
- **8 model providers** — Anthropic, OpenAI, Azure, Google Gemini, OpenRouter, any OpenAI-compatible endpoint, AWS Bedrock, GCP Vertex AI.
- **Code review mode** — `@agent review` reads/searches the PR checkout without shell or repository-edit tools and posts inline comments through an isolated temporary handoff; `@agent review and fix` applies only safe suggestions to changed regular files.
- **Label/assignee triggers** — auto-run the agent without a mention using `auto_run_label` or `auto_run_assignee`.
- **Issue/PR continuity** — follow-up mentions reuse the same branch/PR; `@agent continue` resumes an incomplete plan.
- **Human-in-the-loop gate** — optionally require approval before changes land (draft PR or proposed branch).
- **Sticky progress comment** — one comment, updated in place, with a live checklist, PR link, and token/cost estimate.
- **Cost & spend caps** — token usage and estimated USD cost surfaced in the comment, job summary, and outputs. Optional `max_cost_usd` / `max_total_tokens` ceilings stop a run the moment it crosses the limit.
- **Cross-run memory** — a compact history of prior `@agent` turns on the same issue/PR is carried forward as context on the next mention.
- **Fork-PR protection** — fork PRs are denied by default; maintainers opt in per-PR with a label.
- **Shell guardrails** — backend-enforced command allow-list + always-on deny-list shared by main/subagents; secret-free shell environment. This is a guardrail, not a process sandbox.
- **MCP tools** — connect Model Context Protocol servers to extend the agent's capabilities.
- **Verified commits** — optionally land changes via GitHub App's `createCommitOnBranch` mutation so they show as "Verified".
- **`npx` bootstrap** — `npx create-deep-agent-action` writes a pinned starter workflow and optional repository guidance without handling secrets or repository administration.

## Quick Setup

From the root of an existing Git repository, run:

```sh
npx create-deep-agent-action
```

The creator writes `.github/workflows/deep-agent.yml` and a minimal `.deepagents/AGENTS.md` file, preserving existing files unless `--force` is supplied. It does not create provider secrets or alter Actions settings: add `PROVIDER_API_KEY` yourself and enable the repository setting that permits Actions to create pull requests when using `GITHUB_TOKEN`.

To configure the workflow manually instead, follow the steps below.

**1. Add the workflow** at `.github/workflows/agent.yml`:

```yaml
name: Deep Agent
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  workflow_dispatch:
    inputs:
      prompt:
        description: "Instruction for the agent"
        required: true

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: deep-agent-${{ github.event.issue.number || github.event.pull_request.number || github.run_id }}
  cancel-in-progress: false

jobs:
  agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: dipjyotimetia/deep-agent-action@main
        with:
          model: "claude-sonnet-4-6"
          prompt: ${{ github.event.inputs.prompt }}
        env:
          PROVIDER_API_KEY: ${{ secrets.PROVIDER_API_KEY }}
```

**2. Add one secret.** In Settings → Secrets → Actions, add `PROVIDER_API_KEY` with your model provider's API key.

**3. Use it.** Comment `@agent fix the failing test` on an issue. The agent posts a tracking comment, works through a plan, and opens a PR.

For copy-paste-ready examples (review, approval gate, multi-provider, MCP, fork support, issue automation, scheduled maintenance), see the [`examples/`](../examples) directory and [examples/README.md](../examples/README.md).

## How It Works (High Level)

```
GitHub event → Route → Authorize → Acknowledge → Run agent → Land changes → Finalize
```

The control plane in `src/index.ts` orchestrates a 9-step pipeline. The agent is sandwiched between gating (before) and landing (after), both handled by the control plane — never by the model. For the full pipeline, see the [Architecture Overview](architecture/overview.md).

## Documentation Sections

| Section          | Page                                            | What it covers                                                                                                                  |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Architecture** | [Overview](architecture/overview.md)            | The 9-step control-plane pipeline, agent assembly, review-mode handoff, and critical constraints.                               |
| **Architecture** | [Agent Subsystem](architecture/agent.md)        | Model factory, agent assembly, streaming driver, budget metering, shell guard, MCP, system prompts.                             |
| **Architecture** | [GitHub Operations](architecture/github-ops.md) | Auth, client, tracking comments, thread context, cross-run memory, git ops, verified commits, code review.                      |
| **Guides**       | [Configuration](guides/configuration.md)        | Action inputs, env vars, per-repo config, config merge precedence, shell guardrails.                                            |
| **Guides**       | [Security](guides/security.md)                  | Layered guardrail model: actor validation, fork protection, secret-free shell, command guardrails, approval gate, auditability. |
| **Guides**       | [Testing](guides/testing.md)                    | Unit tests, CI pipeline, live E2E harness, smoke check, result validator.                                                       |
| **Reference**    | [Source Map](reference/source-map.md)           | Concise map of all source files with one-line descriptions.                                                                     |

## Runtime & Tooling

- **Runtime:** Bun (pinned to 1.3.14 in `action.yml`). No build/bundle step — the action runs `src/index.ts` directly.
- **Language:** TypeScript, strict mode, ESM with `.js` import extensions.
- **Dependencies:** `deepagents`, `langchain`, `@langchain/*` provider packages, `@actions/core`, `@actions/github`, `zod`, `yaml`.
- **Dev commands:** `bun run typecheck`, `bun test`, `bun run format:check`, `bun run smoke`.

## Backlog

| Area                         | Source anchor              | Reason deferred                                                                                               |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Deepagents harness internals | `node_modules/deepagents/` | Third-party library; documented via public npm docs, not this repo's source.                                  |
| Triage mode deep-dive        | `src/modes/triage.ts`      | Covered briefly in architecture overview; a dedicated page would duplicate existing docs/security.md content. |
