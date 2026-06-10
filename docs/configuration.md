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
| `prompt` | — | An explicit instruction that bypasses the trigger phrase. Used for `workflow_dispatch`, but works on any event. |

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

### Tools & UX

| Input | Default | Notes |
|---|---|---|
| `mcp_config` | — | MCP servers JSON (see [mcp-tools.yml](../examples/mcp-tools.yml)). |
| `comment_debounce_ms` | `8000` | Minimum interval between edits to the sticky progress comment. |

> **Reserved inputs.** `execution_mode`, `langgraph_url`, and `assistant_id` are declared in `action.yml` as placeholders for a planned hosted "bridge" mode. They are **not implemented** — only the default in-runner mode works today. Leave them unset.

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

### Example

```yaml
# .github/deep-agent.yml
system_prompt: |
  This is a TypeScript monorepo managed with pnpm. Always co-locate tests with
  the code they cover, and never edit files under generated/.
model: claude-opus-4-5
allowed_commands: [git, pnpm, node, pytest]
denied_commands: [rm]
```

### Merge rules

- Repo config is applied **on top of** the workflow inputs.
- `model` and `allowed_commands` **override** the input-derived values when present.
- `denied_commands` is **always re-merged** with the built-in deny-list — a committed config can only strengthen the deny-list, never weaken it.
- A missing or malformed file is ignored (a warning is logged); it never aborts a run.
