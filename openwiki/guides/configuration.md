---
type: Guide
title: Configuration
description: All configuration surfaces for deep-agent-action — action inputs, environment variables, per-repo YAML config, config merge precedence, and shell guardrail defaults.
tags: [configuration, inputs, env-vars, repo-config, shell-guardrails]
---

# Configuration

The action has three configuration surfaces that merge in priority order: action inputs (in `action.yml`), environment variables, and a per-repo YAML file (`.github/deep-agent.yml`). The [Architecture Overview](../architecture/overview.md) explains how config flows through the pipeline.

## Action Inputs

Defined in [`action.yml`](../../action.yml), parsed by `src/config.ts:loadConfig`. Key inputs:

### Triggering

| Input                          | Default  | Description                                                                      |
| ------------------------------ | -------- | -------------------------------------------------------------------------------- |
| `trigger_phrase`               | `@agent` | Phrase that triggers the agent in issue/PR/comment bodies.                       |
| `prompt`                       | —        | Explicit instruction for `workflow_dispatch` runs (bypasses the trigger phrase). |
| `auto_run_label`               | —        | Label that triggers the agent without a trigger-phrase match.                    |
| `auto_run_assignee`            | —        | GitHub username that, when assigned, triggers the agent.                         |
| `auto_run_default_instruction` | —        | Fallback instruction for auto-run events when the issue has no usable text.      |

### Model

| Input      | Default             | Description                                                   |
| ---------- | ------------------- | ------------------------------------------------------------- |
| `model`    | `claude-sonnet-4-6` | Model id, optionally provider-prefixed (e.g. `openai:gpt-5`). |
| `base_url` | —                   | Endpoint URL for the `openai-compatible` provider.            |

### Authorization

| Input                 | Default       | Description                                                     |
| --------------------- | ------------- | --------------------------------------------------------------- |
| `allowed_permissions` | `write,admin` | Comma-separated permission levels allowed to trigger the agent. |
| `fork_allow_label`    | —             | Label a write-access user can apply to authorize fork-PR runs.  |

### Landing

| Input                   | Default | Description                                                                                        |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `require_push_approval` | `false` | Gate changes behind human review (draft PR or proposed branch).                                    |
| `verified_commits`      | `false` | Land via `createCommitOnBranch` GraphQL mutation for "Verified" commits. Requires GitHub App auth. |
| `apply_suggestions`     | `false` | Always apply review suggestions and land them (even without "and fix").                            |

### Triage (Opt-In)

| Input                   | Default | Description                                                          |
| ----------------------- | ------- | -------------------------------------------------------------------- |
| `enable_triage`         | `false` | Classify new issues with no trigger phrase via a one-shot LLM call.  |
| `triage_allowed_labels` | —       | Labels the triage classifier may apply; anything outside is ignored. |
| `triage_model`          | —       | Model for triage classification; defaults to `model`.                |

### Shell Guardrails

| Input                   | Default         | Description                                                   |
| ----------------------- | --------------- | ------------------------------------------------------------- |
| `allowed_commands`      | 25-command list | Comma/newline-separated allow-list of shell command names.    |
| `denied_commands`       | —               | Extra commands to block (merged with the built-in deny-list). |
| `shell_timeout_seconds` | `600`           | Max seconds for a single shell command.                       |

### Identity

| Input             | Default               | Description                                                                 |
| ----------------- | --------------------- | --------------------------------------------------------------------------- |
| `github_token`    | `${{ github.token }}` | Token for GitHub API/git operations. PRs opened with this don't trigger CI. |
| `app_id`          | —                     | GitHub App id for scoped, short-lived installation tokens.                  |
| `app_private_key` | —                     | GitHub App private key (PEM).                                               |

### Cost & Runtime Controls

| Input                 | Default | Description                                                             |
| --------------------- | ------- | ----------------------------------------------------------------------- |
| `max_cost_usd`        | —       | Abort run once estimated spend reaches this many USD.                   |
| `max_total_tokens`    | —       | Abort run once cumulative billed tokens reach this many.                |
| `max_runtime_minutes` | —       | Abort the agent after this many minutes; partial work lands for review. |
| `recursion_limit`     | `150`   | Max LangGraph super-steps per run.                                      |

### Tools & UX

| Input                    | Default | Description                                                       |
| ------------------------ | ------- | ----------------------------------------------------------------- |
| `mcp_config`             | —       | MCP servers JSON: `{ "mcpServers": { name: { command, args, env } | { url } } }`. |
| `harness_profile`        | —       | Optional deepagents harness profile JSON.                         |
| `filesystem_permissions` | —       | Optional deepagents filesystem permission rules JSON.             |
| `comment_debounce_ms`    | `8000`  | Minimum interval between tracking-comment progress edits.         |

## Environment Variables

Provider API keys resolve with this fallback order (via `resolveProviderApiKey()`):

1. `provider_api_key` action input
2. `PROVIDER_API_KEY` env
3. `ANTHROPIC_API_KEY` env
4. `OPENAI_API_KEY` env
5. `GOOGLE_API_KEY` env
6. `OPENROUTER_API_KEY` env

Provider-specific auth chains:

- **Azure:** `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_INSTANCE_NAME`, `AZURE_OPENAI_API_DEPLOYMENT_NAME`, `AZURE_OPENAI_API_VERSION`
- **AWS Bedrock:** standard AWS env chain (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, etc.)
- **GCP Vertex AI:** standard GCP ADC (`GOOGLE_APPLICATION_CREDENTIALS` or `gcloud auth application-default login`)

GitHub App credentials: `APP_ID` and `APP_PRIVATE_KEY` env vars are alternatives to the `app_id` / `app_private_key` action inputs.

## Per-Repo Config (`.github/deep-agent.yml`)

An optional YAML file committed to the repository, loaded by `src/config/repoConfig.ts`.

**Config paths searched** (first match wins): `.github/deep-agent.yml`, `.github/deep-agent.yaml`, `.deep-agent.yml`, `.deep-agent.yaml`

**Supported fields:**

```yaml
system_prompt: "Additional system prompt text appended to the base prompt"
```

**Merge semantics:**

- The repository file can add guidance only; model, shell policy, budgets, filesystem rules, MCP, subagents, and landing policy remain workflow-owner configuration.
- Unknown fields are ignored and malformed config logs a warning rather than aborting the run.

## Built-in Shell Command Lists

### Default allow-list (`DEFAULT_ALLOWED_COMMANDS` in `src/config.ts`)

`git`, `ls`, `cat`, `mkdir`, `touch`, `cp`, `mv`, `node`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `python`, `python3`, `pip`, `pytest`, `go`, `make`, `cargo`, `rustc`, `sed`, `grep`, `find`, `echo`

### Default deny-list (`DEFAULT_DENIED_COMMANDS` — always-on)

`curl`, `wget`, `nc`, `ncat`, `ssh`, `scp`, `sudo`, `su`, `telnet`, `dd`, `mkfs`, `shutdown`, `reboot`

The deny-list cannot be weakened by repo config. See [Security](security.md) for the full guardrail model.

## Deepagents Repository Guidance

The agent auto-discovers (without reading) two repo-local sources:

- **`.deepagents/AGENTS.md`** — loaded as read-only guidance for the agent. Contains project context, conventions, and instructions.
- **`.deepagents/skills/`** — progressive-disclosure `SKILL.md` workflows exposed to the agent.

Filesystem writes under `.deepagents/**` are always denied (security floor in `agent/policy.ts`), even when custom permission rules would allow them.

## Relationships

- Config is consumed by the [control plane](../architecture/overview.md) and the [agent subsystem](../architecture/agent.md).
- Shell guardrails are enforced by the [shell guard](../architecture/agent.md) middleware.
- The security implications of each config option are detailed in [Security](security.md).
- Full reference: [`docs/configuration.md`](../../docs/configuration.md)
