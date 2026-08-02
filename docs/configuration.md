# Configuration

Everything you can tune, in one place. There are three configuration surfaces:

1. [**Action inputs**](#action-inputs) — set in your workflow `with:` block.
2. [**Environment variables**](#environment-variables) — secrets and provider credentials, set in `env:`.
3. [**Per-repo config file**](#per-repo-config-file) — `.github/deep-agent.yml`, committed to the repository.

---

## Action inputs

All inputs are optional. Source of truth: [`action.yml`](../action.yml).

### Triggering

| Input | Default | Notes |
|---|---|---|
| `trigger_phrase` | `@agent` | Matched at a word boundary, case-insensitive — `@agentic` does not match `@agent`. |
| `prompt` | — | An explicit instruction that bypasses the trigger phrase. Used for `workflow_dispatch`, but works on any event — including `schedule`, see [`examples/scheduled-maintenance.yml`](../examples/scheduled-maintenance.yml). |
| `auto_run_label` | — | Label that, when applied to an issue, runs the agent without a trigger-phrase match. The issue's title/body (or `auto_run_default_instruction`) becomes the instruction. |
| `auto_run_assignee` | — | GitHub username that, when assigned to an issue, runs the agent without a trigger-phrase match. |
| `auto_run_default_instruction` | — | Fallback instruction for an `auto_run_label`/`auto_run_assignee` event when the issue has no usable title/body text. |

### Model

| Input | Default | Notes |
|---|---|---|
| `model` | `claude-sonnet-4-6` | Optionally provider-prefixed (`openai:gpt-5`). See [providers.md](providers.md). |
| `base_url` | — | Required for the `openai-compatible` provider; ignored otherwise. |

### Authorization

| Input | Default | Notes |
|---|---|---|
| `allowed_permissions` | `write,admin` | Comma-separated repo permission levels allowed to trigger the agent. `maintain` satisfies a `write` requirement. |
| `fork_allow_label` | — | A label a write-access user applies to a fork PR to authorize a run. If unset, fork PRs **never** run. |

### Landing changes

| Input | Default | Notes |
|---|---|---|
| `require_push_approval` | `false` | Gate landing behind human review: draft PR (issue mode) or a proposed branch + compare link (PR mode). |
| `verified_commits` | `false` | Land via the GitHub App's `createCommitOnBranch` GraphQL mutation instead of `git push`, so commits show as "Verified". **Requires** `app_id`/`app_private_key` — the run fails loudly if set without App auth (no silent fallback to unsigned commits). **Limitation:** the mutation has no file-mode field, so executable-bit/symlink changes are not preserved (files always land as mode `100644`). |
| `apply_suggestions` | `false` | Make every review run also apply its own single-line `suggestion`s directly (grouped by file, applied highest-line-first) and land them as a commit — findings without a clean single-line suggestion still surface as comments. A mention of "review and fix this PR" does this regardless of this input. |

### Triage (opt-in)

| Input | Default | Notes |
|---|---|---|
| `enable_triage` | `false` | On a new issue with no trigger phrase, run a cheap one-shot structured-output classification deciding: open a PR, request a review (only if the issue is actually a PR), ask for clarification, add labels, or do nothing. Only ever acts when the issue's author passes the same human + `allowed_permissions` check as a manual mention — triage never lowers the authorization bar. Skipped entirely if a tracking comment already exists on the issue (so it only ever runs once), and skipped whenever an explicit trigger (phrase, `auto_run_label`/`auto_run_assignee`) already matched. Any resulting `open_pr`/`review` run is forced through the approval gate (draft PR / proposed branch) regardless of `require_push_approval`. |
| `triage_allowed_labels` | — | Labels the triage classifier may apply via the `label` action. Anything it proposes outside this list is dropped. |
| `triage_model` | `model` | Model used for the one-shot classification call — set a cheaper model here to avoid running the full configured model on every untriggered issue. |

### Shell guardrails

| Input | Default | Notes |
|---|---|---|
| `allowed_commands` | dev toolchain (below) | Comma/newline-separated allow-list. Setting it **replaces** the default list. |
| `denied_commands` | — | Extra names to block. Always **merged with** the built-in deny-list. |
| `shell_timeout_seconds` | `600` | Max seconds per shell command. |

**Default allow-list** (from [`src/config.ts`](../src/config.ts)):

```
git, ls, cat, mkdir, touch, cp, mv, node, npm, npx, pnpm, yarn, bun,
python, python3, pip, pytest, go, make, cargo, rustc,
sed, grep, find, echo
```

**Always-on deny-list** (cannot be removed, even via repo config):

```
curl, wget, nc, ncat, ssh, scp, sudo, su, telnet, dd, mkfs, shutdown, reboot
```

The deny-list always wins: a command on both lists is blocked. See [security.md](security.md) for how commands are parsed.

### Identity & landing

| Input | Default | Notes |
|---|---|---|
| `github_token` | `${{ github.token }}` | Token for GitHub API/git. PRs opened with the default token don't trigger downstream CI. |
| `app_id` / `app_private_key` | — | A GitHub App identity (mints a scoped, short-lived token). Use when you need the agent's PRs to run CI. Also read from `APP_ID` / `APP_PRIVATE_KEY`. |
| `require_push_approval` | `false` | When `true`, changes land as a draft PR (issue mode) or a proposed branch + compare link (PR mode) instead of landing directly. |

> **Letting `GITHUB_TOKEN` open PRs.** With the default token you must enable **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"**, or the run fails with _"GitHub Actions is not permitted to create or approve pull requests"_. A GitHub App identity avoids this. See [troubleshooting](troubleshooting.md#github-actions-is-not-permitted-to-create-or-approve-pull-requests).

### Cost & runtime controls

All are unset by default (no cap). A cap is metered across **every** model call — the main agent and its subagents — and aborts the run the instant a ceiling is crossed; the partial work then lands through the approval path (a draft PR / proposed branch) for review, and the matching output (`budget_stopped` or `timed_out`) is set to `true`. Tool interrupts use the separate `interrupted` output. A no-progress loop or recursion ceiling sets `stalled` instead.

| Input | Default | Notes |
|---|---|---|
| `max_cost_usd` | — | Abort once estimated spend reaches this many USD. **Requires a known model price** (see [`src/agent/cost.ts`](../src/agent/cost.ts)); on an unpriced model it never fires, so pair it with `max_total_tokens`. |
| `max_total_tokens` | — | Abort once cumulative billed tokens (input + output) reach this many. The count is **re-evaluated on each model call as the context grows**, not a running sum of fresh tokens — set it generously. |
| `max_runtime_minutes` | — | Abort the agent once it has been running this many minutes. Unlike GitHub's job-level `timeout-minutes` — which kills the job and loses everything — this stops the agent gracefully and lands the partial work as a draft for review. Use both: this cap somewhat below the job timeout. |

A malformed value (e.g. `"$5"` or a negative number) fails the run loudly rather than silently disabling the cap — a budget control has no safe default.

### Tools & UX

| Input | Default | Notes |
|---|---|---|
| `mcp_config` | — | MCP servers JSON (see [mcp-tools.yml](../examples/mcp-tools.yml)). |
| `harness_profile` | — | Strict JSON deepagents harness profile. Supports prompt suffixes, tool-description overrides, excluded tools/middleware, and general-purpose subagent settings. |
| `filesystem_permissions` | — | Strict JSON array of deepagents filesystem rules. Paths must be absolute globs; writes under `.deepagents/` are always denied. |
| `interrupt_on` | — | Strict JSON map of tool names to `true`, `false`, or an `allowedDecisions` object. Configured MCP tools default to `true`. |
| `subagents` | — | Strict JSON array of synchronous specialist declarations. See [Specialist subagents](#specialist-subagents). |
| `comment_debounce_ms` | `8000` | Minimum interval between edits to the sticky progress comment. |
| `recursion_limit` | `150` | Max agent super-steps per run. A long read → edit → test → fix loop can reach the ceiling; raise it only when the work is making progress. |
| `max_repeated_tool_calls` | `8` | Stops an agent after this many identical tool calls without a main-agent todo update. Arguments are compared in memory only and are never added to the public tracking comment. |

### Deepagents memory, skills, and approval

The action automatically discovers only these repository-local sources:

```text
.deepagents/AGENTS.md
.deepagents/skills/<skill-name>/SKILL.md
```

`AGENTS.md` is loaded as always-on project guidance. Skills are loaded progressively: the agent receives their metadata first and reads a full `SKILL.md` only when the task needs it. These `.deepagents` paths are the only repository guidance sources loaded by the harness. The built-in deepagents filesystem tools cannot write under `.deepagents/`; shell policy is enforced separately at the shared backend for the main agent and delegated subagents. It filters commands but does not sandbox allowed processes.

The action's existing sticky-comment memory remains the durable per-issue/PR conversation history. It is separate from repository guidance. The action does not configure a deepagents checkpointer or store because a GitHub runner is ephemeral; an interrupt therefore stops safely and the next `@agent resume` starts a fresh run on the existing branch with the prior comment memory.

When MCP tools are loaded, each tool is interrupted before execution by default. Set an explicit tool to `false` to allow it, or supply an object such as:

```json
{
  "publish_release": {
    "allowedDecisions": ["approve", "reject"],
    "description": "Review the release publication."
  }
}
```

An interrupted run emits `status: interrupted`, `interrupted: true`, and pending tool metadata in `result_json`; partial work is forced through the existing approval path. The safe continuation is a new invocation: review the pending request, then comment `@agent resume`. The new run reuses the existing branch and sticky-comment memory; it does not resume the stopped runner process.

### Specialist subagents

`subagents` opts into named **synchronous** specialists for focused implement-mode work. Each item requires `name`, `description`, and `systemPrompt` (or YAML `system_prompt`). It may select a statically configured provider model, named MCP tools, paths below `/.deepagents/skills/`, deny-only filesystem rules, and a `findings` structured response.

The built-in `general-purpose` subagent cannot be replaced. Referenced MCP tools must exist, specialist MCP calls use the same interrupt policy (and default to approval), and a specialist cannot broaden the main agent's filesystem access. Specialists are not enabled in review mode. Async subagents, external sandbox backends, durable stores, and interpreter tools remain unconfigured because they require separate infrastructure or alter the action's approval boundary.

---

## Environment variables

Set these under `env:` (usually from `secrets`). Provider keys can come from a generic `PROVIDER_API_KEY` or a provider-specific variable.

| Variable | Used for |
|---|---|
| `PROVIDER_API_KEY` | Generic provider key (Anthropic / OpenAI / Google / OpenRouter / OpenAI-compatible). |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` | Provider-specific fallbacks for the key. |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_*` | Azure OpenAI deployment/instance/version. |
| `AWS_REGION` / `AWS_DEFAULT_REGION`, AWS credential chain | AWS Bedrock. |
| `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_LOCATION` / `CLOUD_ML_REGION` | GCP Vertex AI. |
| `APP_ID` / `APP_PRIVATE_KEY` | GitHub App identity (alternative to the inputs). |

Resolution order for the provider key: `provider_api_key` input → `PROVIDER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `GOOGLE_API_KEY` → `OPENROUTER_API_KEY`. See [providers.md](providers.md) for per-provider detail.

> The agent's **shell** never sees these. Secrets are stripped from the agent environment by construction — see [security.md](security.md#3-secret-free-shell).

---

## Per-repo config file

Commit an optional config file to tune the agent per repository without touching the workflow. The action reads the first that exists:

```
.github/deep-agent.yml
.github/deep-agent.yaml
.deep-agent.yml
```

### Fields

Source of truth: [`src/config/repoConfig.ts`](../src/config/repoConfig.ts).

| Field | Type | Effect |
|---|---|---|
| `system_prompt` | string | Extra instructions appended to the agent's base system prompt. |
| `model` | string | Overrides the workflow's `model` input. |
| `allowed_commands` | string[] | **Replaces** the allow-list (workflow input or default). |
| `denied_commands` | string[] | **Merged into** the deny-list. |
| `auto_run_label` | string | Overrides the workflow's `auto_run_label` input. |
| `auto_run_assignee` | string | Overrides the workflow's `auto_run_assignee` input. |
| `harness_profile` | mapping | Deepagents harness profile. Invalid repository values are ignored; an explicit workflow input wins. |
| `filesystem_permissions` | mapping[] | Deepagents filesystem permission rules. The action always prepends a deny rule for writes under `.deepagents/`. |
| `interrupt_on` | mapping | Deepagents HITL tool policy. Configured MCP tools still default to interruption. |
| `subagents` | mapping[] | Synchronous specialist declarations. Invalid repository values are ignored; an explicit workflow input wins. |

### Example

```yaml
# .github/deep-agent.yml
system_prompt: |
  This is a TypeScript monorepo managed with pnpm. Always co-locate tests with
  the code they cover, and never edit files under generated/.
model: claude-sonnet-4-6
allowed_commands: [git, pnpm, node, pytest]
denied_commands: [rm]
harness_profile:
  systemPromptSuffix: "Prefer the repository's established patterns."
filesystem_permissions:
  - operations: [read]
    paths: ["/src/**"]
interrupt_on:
  publish_release: true
subagents:
  - name: release-reviewer
    description: Review release readiness.
    system_prompt: Report concise, actionable findings only.
    mcp_tools: [publish_release]
    response_mode: findings
```

### Merge rules

- Repo config is applied on top of the workflow inputs for the original tuning fields.
- `model` and `allowed_commands` **override** the input-derived values when present.
- For `harness_profile`, `filesystem_permissions`, `interrupt_on`, and `subagents`, an explicitly supplied workflow input wins; repository values are defaults.
- `denied_commands` is **always re-merged** with the built-in deny-list — a committed config can only strengthen the deny-list, never weaken it.
- The `.deepagents/` write-protection floor is always prepended, even when custom filesystem rules allow broader writes.
- A missing or malformed file is ignored (a warning is logged); it never aborts a run.
