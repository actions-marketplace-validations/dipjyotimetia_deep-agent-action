---
type: Architecture
title: Agent Subsystem
description: Model factory, agent assembly, streaming driver, budget metering, shell guard, MCP tool loading, and prompt construction for the deepagents-based AI agent.
tags: [agent, model, streaming, budget, shell-guard, mcp, prompt]
---

# Agent Subsystem

The agent subsystem (`src/agent/`) assembles and drives the AI coding agent. It wraps the [`deepagents`](https://www.npmjs.com/package/deepagents) harness with model selection, security middleware, budget enforcement, and streaming progress.

## Model Factory (`model.ts`)

`createModel({ provider, model, apiKey?, baseUrl? })` returns a LangChain `BaseChatModel` instance.

**Supported providers:**

| Provider | LangChain class | Notes |
|---|---|---|
| `anthropic` | `ChatAnthropic` | Default. Bare `claude-*` names infer this. |
| `openai` | `ChatOpenAI` | Bare `gpt-*` / `o*` names infer this. |
| `azure` | `AzureChatOpenAI` | Uses Azure env vars (`AZURE_OPENAI_API_KEY`, etc.). |
| `google` / `gemini` | `ChatGoogleGenerativeAI` | Bare `gemini-*` names infer this. |
| `openrouter` | `ChatOpenAI` | Custom `baseURL` to OpenRouter. |
| `openai-compatible` | `ChatOpenAI` | Requires `base_url`. Groq, xAI, DeepSeek, Together, Ollama, vLLM. |
| `bedrock` | `ChatBedrockConverse` | AWS env chain. |
| `vertexai` | `ChatVertexAI` | GCP ADC. |

**Critical design decision:** All provider classes use *static imports*, not dynamic `import()`. This is because bundlers and Bun's runtime cannot resolve LangChain's dynamic import paths. The smoke check (`DEEP_AGENT_SMOKE=1 bun run src/index.ts`) instantiates every provider to catch import failures.

Provider inference from bare model names is handled by `PROVIDER_BY_PREFIX` in `config.ts` (`claude` → anthropic, `gpt`/`o` → openai, `gemini` → google). Explicit `provider:name` syntax always takes precedence.

See [Configuration](../guides/configuration.md) for the full input resolution flow and [docs/providers.md](../../docs/providers.md) for provider-specific setup.

## Agent Assembly (`createAgent.ts`)

`buildAgent(opts)` constructs the complete agent graph via `createDeepAgent` from the `deepagents` package.

### Key assembly steps:

1. **Guarded shell backend** — `GuardedLocalShellBackend` extends `LocalShellBackend`, rooted at the workspace with `virtualMode: true`. Filesystem paths are contained to the repo. Command allow/deny policy and audit recording live in `execute()`, so the main agent and delegated subagents share the same enforcement boundary. Allowed commands still execute directly on the runner; this is a guardrail, not a process sandbox.

2. **CompositeBackend** — wraps the shell backend with a `/` route. Deepagents rejects filesystem permissions on a raw shell backend (since shell can bypass path rules); the composite makes the permission scope explicit.

3. **Policy resolution** (`resolveAgentPolicy`) — discovers `.deepagents/AGENTS.md` and `.deepagents/skills/` (without reading them), builds the interrupt policy (MCP tools interrupted by default), and builds filesystem permissions with a security-floor deny-write for `/.deepagents/**` prepended before any custom rules.

4. **Harness profile** — optional `HarnessProfile` from the `harness_profile` input, validated by `agent/policy.ts:parseHarnessProfileValue`. The legacy `ShellGuardMiddleware` exclusion name remains protected because command policy is now enforced below middleware and cannot be excluded.

5. **Mode-specific filesystem middleware** — Deepagents 1.11 middleware replacement configures all filesystem tools in implement mode. Review mode exposes only `ls`, `read_file`, `write_file`, `glob`, and `grep`; permissions make `/review-output/**` its only writable path.

6. **MCP tools** — extra LangChain tools from MCP servers are added in implement mode only.

7. **MemorySaver checkpointer** — only created when `interruptOn` is set (LangGraph's interrupt primitive requires a checkpointer).

## Streaming Driver (`stream.ts`)

`runAgentStream(agent, input, options)` drives the agent via LangGraph streaming and collects the final result.

### Key behaviors:

- **Stream mode:** `"values"` with `subgraphs: true` — each chunk carries full state (latest `todos` and `messages`) from both the main agent and subagent namespaces.

- **Progress mirroring:** The `todos` plan is mirrored to the tracking comment, debounced by `debounceMs` (configurable via `comment_debounce_ms`, default 8000ms). Only fires when the plan actually changes. A final mirror always runs so the closing state is reflected.

- **Main agent only:** The canonical plan/summary comes from the main agent (empty namespace). Subagent state is only scanned for tool activities.

- **Activity tracking:** Tool calls and results are deduplicated via a `Set<string>` of `type:namespace/id` keys to prevent duplicate entries across overlapping stream chunks. Activities are recorded into `record.activities`.

- **Budget + timeout:** A single shared `AbortController` is used by both the `BudgetMeter` callback and a `setTimeout` timer. Either can call `controller.abort()`, which propagates into subagent invokes. Cancellation errors from deliberate aborts are swallowed; other errors propagate.

- **Token reporting:** Uses the *larger* of the meter total (includes subagent spend) and the message-summed total (covers providers that report on messages but not callbacks), so a metered run never under-reports.

- **Stop reasons:** `meter?.stopped` → `"budget"`; `timedOut` → `"timeout"`; `interrupted` → `"interrupt"`.

### Pending interrupts

When deepagents' HITL middleware pauses before a tool call, the interrupt is extracted from the stream state and recorded as `PendingToolRequest[]`. The run stops with `"interrupt"`, partial work lands through the approval path, and a later `@agent resume` starts a fresh run.

## Budget Metering (`budget.ts` + `cost.ts`)

### Why a callback handler, not a stream-loop check?

`deepagents` runs subagents via opaque `subagent.invoke(...)` that only returns a `ToolMessage` to the parent — subagent token usage never appears in the parent's streamed messages. A message-summing cap would silently undercount and fail open. The `BudgetMeter` (extends `BaseCallbackHandler`) fires `handleLLMEnd` for subagent calls too (the parent run config spreads), so the meter sees everything.

### Cost estimation (`cost.ts`)

`estimateCostUsd(model, tokens)` returns a rough USD estimate or `undefined` for unknown models. Prices are substring-matched by model-name regex (e.g. `/claude.*opus/i` → $15/$75 per 1M tokens). Unknown models return `undefined`, meaning cost-caps silently don't apply — pair `max_cost_usd` with `max_total_tokens` for unpriced models.

`evaluateBudget(model, tokens, limits)` is a pure function returning a `BudgetVerdict`. It is testable and reusable by the `BudgetMeter`.

## Shell Guard (`shellGuard.ts`)

`GuardedLocalShellBackend.execute(command)` evaluates and records every shell request before delegating allowed commands to `LocalShellBackend`.

### Two-layer check:

1. **Per-segment executable check** — splits the command into operator-separated segments (`&&`, `||`, `|`), extracts the executable basename (skipping `VAR=value` prefixes), and checks each against the allow/deny sets.

2. **Global token scan** — scans all tokens for denied commands hidden inside `$(...)` substitutions.

Blocked commands are short-circuited at the backend and return exit code `126`; the host shell is never called. Every call (allowed or blocked) is recorded into the `ToolCallRecord[]` for audit.

The shell guard is explicitly described as a *guardrail, not a sandbox* — the real isolation comes from the curated secret-free environment (`env.ts`).

## Secret-Free Environment (`env.ts`)

`buildShellEnv(source?)` constructs a curated environment for the agent's shell using an **allow-list** approach. Only non-secret env var names (PATH, HOME, toolchain locations, non-secret GitHub runner context) are included. Secrets like `GITHUB_TOKEN`, `INPUT_*`, provider API keys are excluded by construction — they can never appear because they're not in the list.

`CI=true` and `GIT_TERMINAL_PROMPT=0` are added to prevent interactive prompts from blocking the run.

See [Security](../guides/security.md) for the full guardrail model.

## MCP Tool Loading (`mcp.ts`)

`loadMcpTools(configJson)` parses a JSON config string describing MCP servers, creates a `MultiServerMCPClient`, and returns discovered tools as LangChain `DynamicStructuredTool[]`.

**Design: best-effort / fail-safe.** Invalid JSON, schema mismatch, or connection failure logs a `core.warning` and returns an empty handle. A broken MCP config never aborts the run. Config is workflow-author-controlled (not untrusted user input).

## Policy & Permissions (`policy.ts`)

This module validates JSON configuration for three deepagents policy surfaces:

- **Harness profiles** — `parseHarnessProfileValue` validates via `deepagents.parseHarnessProfileConfig`. The legacy `ShellGuardMiddleware` name cannot be excluded because backend command policy is mandatory.
- **Filesystem permissions** — `parseFilesystemPermissionsValue` validates rules via Zod. Paths must be absolute, no `..` or `~`.
- **Interrupt policies** — `parseInterruptPolicyValue` validates tool interrupt rules.

`discoverDeepAgentSources(rootDir)` checks for `.deepagents/AGENTS.md` and `.deepagents/skills/` without reading them (deepagents loads them at agent construction time).

`buildFilesystemPermissions(custom?)` prepends a deny-write rule for `/.deepagents/**` as a security floor. Deepagents evaluates rules in declaration order, so this must precede user-provided permissions.

`buildInterruptPolicy(mcpToolNames, custom?)` interrupts all MCP tools by default, with user overrides on top.

## Prompt Construction (`prompt.ts`)

- **`buildSystemPrompt(ctx, { isPRMode })`** — sets the agent's role, conventions, and constraints. Emphasizes smallest change, matching code style, running existing tests, and *not* committing/pushing (the control plane handles that). Repository guidance under `.deepagents/` is framed as read-only context.

- **`buildUserMessage(instruction, ctx, memoryContext?, threadContext?)`** — assembles the initial user message. Thread context (issue/PR title, body, prior comments) is framed as *data, not instructions* — attacker-controllable text must never be read as a directive.

- **`buildReviewSystemPrompt(ctx)`** — restricted code-review prompt. Instructs the agent to write findings as JSON to `/review-output/findings.json`, the only writable route.

- **`buildReviewUserMessage(instruction, files, memoryContext?, threadContext?)`** — renders the PR diff for the agent.

## Relationships

- The agent is assembled by [createAgent.ts](overview.md) and driven by the [control plane](overview.md) in `src/index.ts`.
- Changes are landed via [GitHub Operations](github-ops.md) (`ops.ts` or `graphqlCommit.ts`).
- The agent is configured through [Configuration](../guides/configuration.md) and secured by the guardrails in [Security](../guides/security.md).
