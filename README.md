# Deep Agent Action

> An AI coding agent for your GitHub issues and pull requests — mention `@agent`, and it plans, edits, runs your toolchain, and opens a PR. Powered by the [Deep Agents](https://www.npmjs.com/package/deepagents) JS harness, running in-process on your runner.

[![CI](https://github.com/dipjyotimetia/deep-agent-action/actions/workflows/ci.yml/badge.svg)](https://github.com/dipjyotimetia/deep-agent-action/actions/workflows/ci.yml)
[![E2E](https://github.com/dipjyotimetia/deep-agent-action/actions/workflows/e2e.yml/badge.svg)](https://github.com/dipjyotimetia/deep-agent-action/actions/workflows/e2e.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-000000.svg?logo=bun)](https://bun.sh)

Comment `@agent fix the failing test` on an issue and get a pull request back. Comment `@agent review` on a PR and get an inline code review. No hosted service, no extra infrastructure — the agent runs entirely inside your GitHub Actions runner, using a model provider of your choice.

---

## Table of contents

- [Why this action](#why-this-action)
- [Features](#features)
- [Quickstart](#quickstart)
- [Demo](#demo)
- [How it works](#how-it-works)
- [Usage modes](#usage-modes)
- [Models & providers](#models--providers)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Per-repo configuration](#per-repo-configuration)
- [Security](#security)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Versioning](#versioning)
- [Contributing](#contributing)
- [License](#license)

## Why this action

| | Deep Agent Action |
|---|---|
| **Setup** | Copy one workflow, add one secret. No app install wizard, no hosted backend. |
| **Where it runs** | In-process on your runner — your code never leaves your CI. |
| **Models** | 8 providers: Anthropic, OpenAI, Azure OpenAI, Google Gemini, OpenRouter, any OpenAI-compatible endpoint, AWS Bedrock, GCP Vertex AI. |
| **Safety** | Command allow/deny guardrails, secret-free shell, fork-PR protection, permission gating, and an optional human-approval gate — on by default or one flag away. |
| **Feedback** | A single sticky comment shows a live plan, progress, the PR link, and token/cost estimates. |

## Features

- 🤖 **In-runner agent** — plans, reads and edits files, runs your toolchain, commits, and opens a PR. No external service.
- 💬 **`@agent` triggers** — works from issue comments, PR comments, PR review comments, new issues, and new PRs. Manual runs via `workflow_dispatch` too.
- 🔌 **8 model providers** — Anthropic, OpenAI, Azure, Google Gemini, OpenRouter, OpenAI-compatible (Groq, xAI, DeepSeek, Together, Ollama, vLLM, …), AWS Bedrock, GCP Vertex AI.
- 🔍 **Code review mode** — `@agent review` reads the PR diff and posts inline review comments.
- ✋ **Human-in-the-loop gate** — optionally require approval before changes land (draft PR or proposed branch + compare link).
- 📌 **Sticky progress comment** — one comment, updated in place, with a live checklist, summary, PR link, and token/cost estimate.
- 💰 **Cost reporting** — token usage and an estimated USD cost surfaced in the comment, job summary, and machine-readable output.
- 🛡️ **Shell guardrails** — an allow-list and an always-on deny-list for shell commands, plus a secret-free environment.
- 🍴 **Fork-PR protection** — fork PRs are denied by default; maintainers opt in per-PR with a label.
- 🧰 **MCP tools** — connect Model Context Protocol servers to extend what the agent can do.
- 🚀 **Zero-config** — sensible defaults for everything; the only required secret is your model provider key.

## Quickstart

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

**2. Add one secret.** In **Settings → Secrets and variables → Actions**, add `PROVIDER_API_KEY` with your model provider's API key (e.g. an Anthropic key for the default model).

**3. Use it.** Open an issue and comment:

```
@agent add input validation to the signup form and a test for it
```

The agent posts a tracking comment, works through a plan, and opens a pull request with the change.

> [!TIP]
> That's the whole setup. Everything else on this page is optional tuning. For a copy-paste-ready file with inline comments, see [`examples/agent.yml`](examples/agent.yml).

## Demo

Want to see it work before wiring it into your repo? Run the **Demo** workflow (**Actions → Demo → Run workflow**) — it runs the agent on a visible task and opens a real pull request you can browse. The [E2E badge](https://github.com/dipjyotimetia/deep-agent-action/actions/workflows/e2e.yml) above also reflects a nightly live run that exercises implement, approval-gate, and review modes against this repo.

See [docs/demo.md](docs/demo.md) for a walkthrough, sample output, and the `result_json` shape.

## How it works

```
GitHub event (comment / issue / PR / dispatch)
        │
        ▼
1. Route  ─ is there a trigger phrase or explicit prompt? ── no ─▶ no-op (exit)
        │ yes
        ▼
2. Authorize ─ human actor? sufficient permission? fork allowed? ── no ─▶ refuse (comment)
        │ yes
        ▼
3. Acknowledge ─ 👀 reaction + create/reuse the sticky tracking comment
        │
        ▼
4. Run the agent
        ├─ agent mode   → edit files, run toolchain, commit
        └─ review mode  → read the PR diff, collect findings
        │
        ▼
5. Land the result
        ├─ open a PR / push to the PR branch  (or a draft PR / proposed branch if approval is required)
        └─ post inline review comments
        │
        ▼
6. Finalize ─ update the sticky comment (status, plan, PR link, tokens/cost) + emit outputs + audit artifact
```

The agent only acts when it is both **triggered** (a mention or explicit prompt) and **authorized** (a human collaborator with write/admin access). Secrets are never exposed to the agent's shell. See the [security model](docs/security.md) for the full picture.

## Usage modes

| You want to… | Where | Comment |
|---|---|---|
| Implement a change | An **issue** | `@agent implement X` → opens a PR |
| Fix / extend a PR | A **pull request** | `@agent address the review feedback` → pushes to the PR branch |
| Get a code review | A **pull request** | `@agent review` → posts inline comments |
| Run unattended | **Actions tab** → *Run workflow* | provide a `prompt` input (no mention needed) |

The agent enters **review mode** automatically when the instruction starts with `review` on a pull request; otherwise it implements.

## Models & providers

Set the `model` input (default `claude-sonnet-4-6`). A bare model name infers the provider (`claude…` → Anthropic, `gpt…`/`o…` → OpenAI, `gemini…` → Google); otherwise prefix it with `provider:`.

| Provider | Example `model` | Auth |
|---|---|---|
| Anthropic | `claude-sonnet-4-6` | `PROVIDER_API_KEY` (or `ANTHROPIC_API_KEY`) |
| OpenAI | `openai:gpt-5` | `PROVIDER_API_KEY` (or `OPENAI_API_KEY`) |
| Azure OpenAI | `azure:<deployment>` | `AZURE_OPENAI_*` env vars |
| Google Gemini | `google:gemini-2.5-pro` | `PROVIDER_API_KEY` (or `GOOGLE_API_KEY`) |
| OpenRouter | `openrouter:openai/gpt-4o` | `PROVIDER_API_KEY` (or `OPENROUTER_API_KEY`) |
| OpenAI-compatible | `openai-compatible:llama-3.1-70b` + `base_url` | `PROVIDER_API_KEY` |
| AWS Bedrock | `bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0` | AWS env chain (`AWS_REGION`, …) |
| GCP Vertex AI | `vertexai:gemini-2.5-pro` | ADC / `GOOGLE_APPLICATION_CREDENTIALS` |

Full per-provider setup (env vars, regions, credentials) is in [docs/providers.md](docs/providers.md).

## Inputs

All inputs are optional.

| Input | Description | Default |
|---|---|---|
| `trigger_phrase` | Phrase that triggers the agent in issue/PR/comment bodies. | `@agent` |
| `prompt` | Explicit instruction (e.g. for `workflow_dispatch`); bypasses the trigger phrase. | — |
| `model` | Model id, optionally provider-prefixed. See [Models & providers](#models--providers). | `claude-sonnet-4-6` |
| `base_url` | Endpoint URL for the `openai-compatible` provider. | — |
| `mcp_config` | MCP servers JSON: `{ "mcpServers": { name: { command, args, env } \| { url } } }`. | — |
| `allowed_permissions` | Comma-separated repo permission levels allowed to trigger the agent. | `write,admin` |
| `allowed_commands` | Comma/newline-separated allow-list of shell commands. | a common dev toolchain¹ |
| `denied_commands` | Extra command names to block (merged with the built-in deny-list). | — |
| `fork_allow_label` | Label a write-access user applies to authorize the agent on a fork PR. If unset, fork PRs never run. | — |
| `shell_timeout_seconds` | Max seconds for a single shell command. | `600` |
| `comment_debounce_ms` | Minimum interval between tracking-comment progress edits. | `8000` |
| `provider_api_key` | Model provider API key. Also read from `PROVIDER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY`. | — |
| `app_id` | GitHub App id used to mint a scoped installation token. Also read from `APP_ID`. | — |
| `app_private_key` | GitHub App private key (PEM). Also read from `APP_PRIVATE_KEY`. | — |
| `github_token` | Token for GitHub API/git operations. | `${{ github.token }}` |
| `require_push_approval` | Gate landing of changes behind human review (draft PR / proposed branch). | `false` |

¹ Default `allowed_commands`: `git, ls, cat, mkdir, touch, cp, mv, node, npm, npx, pnpm, yarn, bun, python, python3, pip, pytest, go, make, cargo, rustc, sed, grep, find, echo`. Always-on deny-list: `curl, wget, nc, ncat, ssh, scp, sudo, su, telnet, dd, mkfs, shutdown, reboot`. See [docs/configuration.md](docs/configuration.md).

> [!NOTE]
> PRs opened with the default `GITHUB_TOKEN` do **not** trigger your other CI workflows. If you need the agent's PRs to run CI, configure a GitHub App (`app_id` + `app_private_key`). See [examples/github-app.yml](examples/github-app.yml).

## Outputs

| Output | Description |
|---|---|
| `status` | Run outcome: `success` \| `skipped` \| `refused` \| `failed`. |
| `pr_url` | URL of the opened pull request (or compare link), if any. |
| `branch` | Branch the agent pushed to, if any. |
| `result_json` | Machine-readable run record (plan, files changed, tokens, cost, outcome). |

Every run also writes a job summary and uploads a `deep-agent-run` artifact (`deep-agent-run.json`) as an audit record.

## Per-repo configuration

Commit an optional `.github/deep-agent.yml` to tune the agent for a repository without editing the workflow:

```yaml
# .github/deep-agent.yml
system_prompt: |
  This is a TypeScript monorepo managed with pnpm. Always co-locate tests with
  the code they cover, and never edit files under generated/.
model: claude-opus-4-5
allowed_commands: [git, pnpm, node, pytest]
denied_commands: [rm]
```

Repo config merges over the workflow inputs. A committed config can narrow the allow-list and add denials, but it can never weaken the built-in deny-list. Full field reference in [docs/configuration.md](docs/configuration.md).

## Security

The agent runs untrusted, model-generated commands, so the action is defensive by default:

- **Permission gating** — only human collaborators with `write`/`admin` (configurable) can trigger it; bot accounts are ignored to prevent loops.
- **Fork-PR protection** — fork PRs are denied unless a maintainer applies the `fork_allow_label`.
- **Secret-free shell** — the agent's shell sees an allow-listed, secret-free environment; provider keys and `GITHUB_TOKEN` are never exposed to it.
- **Command guardrails** — an allow-list plus an always-on deny-list (network/privilege tools are blocked even if allow-listed).
- **Human-approval gate** — `require_push_approval: true` holds changes behind a draft PR or a proposed branch for review.

This is a guardrail model, not a sandbox — run it on the providers and repos you trust. See [docs/security.md](docs/security.md) for the full threat model, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Examples

Ready-to-copy workflows live in [`examples/`](examples/):

| Example | What it shows |
|---|---|
| [`agent.yml`](examples/agent.yml) | The all-in-one starting point. |
| [`review.yml`](examples/review.yml) | Code-review-only setup for pull requests. |
| [`approval-gate.yml`](examples/approval-gate.yml) | Require human approval before changes land. |
| [`multi-provider.yml`](examples/multi-provider.yml) | OpenAI, Bedrock, Vertex, OpenRouter, and OpenAI-compatible variants. |
| [`mcp-tools.yml`](examples/mcp-tools.yml) | Extend the agent with MCP servers. |
| [`github-app.yml`](examples/github-app.yml) | Use a GitHub App so the agent's PRs trigger your CI. |

## Troubleshooting

A few common cases — full guide in [docs/troubleshooting.md](docs/troubleshooting.md).

- **Nothing happened.** Check the workflow listens to the event you used (e.g. `issue_comment`), the comment contains the exact trigger phrase at a word boundary, and the run wasn't a no-op in the Actions log.
- **"Request not authorized."** The actor needs `write`/`admin` access (per `allowed_permissions`), or it's a fork PR without the `fork_allow_label`, or the actor is a bot.
- **The agent's PR didn't run my CI.** Expected with the default `GITHUB_TOKEN` — switch to a GitHub App (see [examples/github-app.yml](examples/github-app.yml)).
- **Cost shows tokens but no `$`.** The model name isn't in the estimate table; usage is still reported. See [`src/agent/cost.ts`](src/agent/cost.ts).

## Versioning

Pin to a ref you trust. `@main` tracks the latest:

```yaml
- uses: dipjyotimetia/deep-agent-action@main
```

For reproducible builds, pin to a commit SHA:

```yaml
- uses: dipjyotimetia/deep-agent-action@<commit-sha>
```

## Contributing

Contributions are welcome. The action is TypeScript run directly on [Bun](https://bun.sh) — no build/bundle step. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, project layout, and how to add a provider.

## License

[MIT](LICENSE) © Dipjyoti Metia
