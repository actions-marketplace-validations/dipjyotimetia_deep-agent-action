# Feature review

A point-in-time audit of the action's feature surface against best practices for agentic GitHub Actions (benchmarked against mature actions such as `anthropics/claude-code-action`). It records what the action does well, the gaps that review closed, and the larger items deliberately deferred to a roadmap rather than half-built.

## Strengths

- **Control-plane security model.** Gating (fork protection, human check, permission check) runs before the agent; landing (commit/branch/push/PR) runs after it — the model never holds credentials or runs git. See [security.md](security.md).
- **Secret-free agent shell by construction.** `src/agent/env.ts` is an allow-list of env var names; provider keys, `GITHUB_TOKEN`, App keys, and `INPUT_*` can never reach a model-directed command.
- **Unweakenable command deny-list.** A committed `.github/deep-agent.yml` can narrow the allow-list and add denials, but the built-in deny-list is always re-merged (`src/config.ts`).
- **Budget metering that counts subagents.** The `BudgetMeter` is a LangChain callback (not a stream-loop check), so subagent token spend is metered too, and a breach aborts mid-subagent. Budget/runtime stops land partial work through the approval path instead of losing it.
- **Sticky tracking comment with live plan + cross-run memory.** One comment per thread, updated in place, carrying a hidden, base64-encoded turn history that is fed back fenced as *data, not instructions* (prompt-injection guard, `src/github/memory.ts`).
- **Deepagents-native project policy.** Repository `.deepagents/AGENTS.md` memory and progressive-disclosure skills are wired through the backend, with strict profile/permission/interrupt validation and an always-on write-protection floor for `.deepagents/`.
- **Safe HITL interruptions.** MCP tools pause before execution by default; interrupted runs preserve audit metadata and partial work through the existing approval path without pretending an ephemeral runner can resume a graph.
- **Typed activity visibility.** Tool calls and results from main and subagent streams are deduplicated into the tracking comment and audit record.
- **Static provider imports + smoke check.** All 8 providers are constructed via static imports; CI's smoke step catches the provider-package-loading class of bug that unit tests cannot.
- **Auditability.** Every run emits `result_json`, a job summary, and a retained `deep-agent-run.json` artifact recording the plan, every tool call (including blocked ones and why), files changed, tokens, and cost.
- **Honest docs.** Documented features match the implementation; reserved-but-unimplemented inputs (`execution_mode: bridge`) say so in their descriptions.

## Gaps closed by this review

| Gap | Fix |
|---|---|
| No retry on GitHub API calls — a transient 5xx or secondary rate limit failed the run | Retry hook on every Octokit instance (`src/github/client.ts`): exponential backoff, rate limits retried for all methods, 5xx retried for GET/HEAD only (a retried mutation could double-post) |
| Comment bodies could exceed GitHub's 65,536-char limit and fail the API call | `truncateBody` (`src/github/text.ts`) clamps at the API boundary, preserving the tracking marker and the memory block |
| No run-level wall-clock cap — only GitHub's job `timeout-minutes`, which kills the job and loses all work | `max_runtime_minutes` input: aborts the agent gracefully via the shared `AbortController` and lands partial work as a draft, with a `timed_out` output |
| LangGraph recursion limit hardcoded at 150 | `recursion_limit` input |
| Review findings were plain text | Optional `severity` (`critical`/`warning`/`info`) and `suggestion` fields — rendered as a bold prefix and a one-click GitHub suggested change (`src/github/review.ts`) |
| Review mode could reach repository edit/shell tools and wrote its handoff into the checkout | Mode-specific filesystem tools, isolated temporary review output, and changed-file/containment/symlink checks before auto-applying suggestions |
| Delegated subagents could bypass main-agent shell middleware | Command policy moved to the shared local-shell backend, with delegated-subagent regression coverage |
| Simultaneous mentions raced the sticky comment/memory (last write wins) and could push non-fast-forward | `concurrency` group documented in the README quickstart, every example workflow, and [troubleshooting.md](troubleshooting.md) |
| System prompt claimed "network access is unavailable" (only specific commands are denied) | Reworded to the accurate claim: no credentials + denied fetch commands |
| Permission-lookup failures were swallowed silently; push failures surfaced raw git errors (and could echo the tokenized remote URL) | Failure reason logged as a warning; push errors pass stderr through `explainGitHubError` (protected-branch and non-fast-forward hints) with the access token redacted |
| Deepagents had first-class memory/skills/policy/HITL features available but the action did not expose them | Repository-local memory and skills, strict policy inputs, protected filesystem rules, MCP-default interrupts, typed activity, and explicit interrupted status |

## Roadmap (deliberately deferred)

These are real gaps versus the strongest agentic actions, each big enough to deserve its own design rather than a bolt-on:

- **`execution_mode: bridge`.** The reserved inputs (`execution_mode`, `langgraph_url`, `assistant_id`) exist in `action.yml` for a hosted-agent mode; only `in_runner` is implemented.
- **A real sandbox backend.** The shell guard is a guardrail, not a sandbox: allow-listed interpreters (`node`, `python`, `go`, …) can open sockets, so network isolation ultimately rests on the secret-free env. A container/jail execution backend would make the "no network" property enforceable.
- **Cost-table coverage.** `src/agent/cost.ts` prices the major Anthropic/OpenAI/Gemini families; Bedrock/Vertex model ids and newer models fall back to token-only reporting (pair `max_cost_usd` with `max_total_tokens` meanwhile).
- **Budget fail-open on silent providers.** A provider reporting neither `usage_metadata` nor `llmOutput.tokenUsage` contributes zero to the meter, so token caps can't bind for it. `max_runtime_minutes` now provides a provider-independent backstop.
- **Cancellation handling.** A cancelled workflow job currently strands the tracking comment on "Working on it…"; a small cleanup path (or a `cancel-in-progress` note) would close the loop.
