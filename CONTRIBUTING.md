# Contributing

Thanks for your interest in improving Deep Agent Action! This guide covers the dev setup, the project layout, and how to make common changes.

## Prerequisites

- [Bun](https://bun.sh) **1.3.14** (the version the action pins). Install with `curl -fsSL https://bun.sh/install | bash`.
- A GitHub account. For end-to-end testing, a sandbox repo where you can run the action.

There is **no build/bundle step** — the action runs `src/index.ts` directly via `bun run`. You won't find or commit a `dist/` bundle.

## Setup

```bash
git clone https://github.com/dipjyotimetia/deep-agent-action.git
cd deep-agent-action
bun install
```

## Dev loop

Run these before opening a PR — CI runs the same checks ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
bun run typecheck     # tsc --noEmit
bun test              # unit tests (test/*.test.ts)
bun run format:check  # prettier --check
bun run smoke         # loads every provider package to catch bundling/import errors
```

Auto-fix formatting with `bun run format`.

The **smoke** check (`DEEP_AGENT_SMOKE=1 bun run src/index.ts`) instantiates all provider models and exits. It catches import/packaging issues that the source-run tests miss, so run it after touching dependencies or [`src/agent/model.ts`](src/agent/model.ts).

## Project layout

```
action.yml                 # Action metadata: inputs, outputs, composite run steps
src/
  index.ts                 # Entry point: route event → authorize → run → land result
  config.ts                # Parse/normalize inputs; default allow/deny lists
  config/repoConfig.ts     # Optional .github/deep-agent.yml loader
  outputs.ts               # Action outputs, job summary, audit artifact
  types.ts                 # Shared types
  agent/
    model.ts               # Multi-provider model factory  ← add providers here
    createAgent.ts         # Assemble the Deep Agent (model + guardrails + tools)
    prompt.ts              # System/user prompts (implement & review)
    stream.ts              # Run the agent, mirror progress to the comment
    shellGuard.ts          # Command allow/deny enforcement
    env.ts                 # Secret-free shell environment allow-list
    mcp.ts                 # Load MCP servers
    cost.ts                # Token → USD estimate
  github/
    context.ts             # Parse the event payload
    client.ts / auth.ts    # Octokit client + token / GitHub App auth
    comments.ts            # Sticky tracking comment
    review.ts              # PR review flow
    ops.ts                 # git operations: branch, commit, push, open PR
    fork.ts                # Fork-PR gating
    validation/            # trigger / actor / permission checks
  modes/detector.ts        # Route event → agent | review | noop
test/                      # One *.test.ts per module
examples/                  # Consumer workflows
docs/                      # Configuration, providers, security, troubleshooting
scripts/e2e/               # Live E2E harness helpers (result validator)
```

## Testing

Two layers:

**Unit tests** (`bun test`) — fast, deterministic, no network. They cover the pure logic module by module: routing, trigger parsing, permission/actor/fork gating, cost estimation, comment rendering, and the E2E harness helpers in `scripts/e2e/`. These run in [CI](.github/workflows/ci.yml) on every push. Run a subset with `bun test test/<file>.test.ts`.

**Live E2E** ([`.github/workflows/e2e.yml`](.github/workflows/e2e.yml)) — runs the action *as shipped* against this repository with a real model and the real GitHub API, then cleans up. It's the only layer that exercises the full `src/index.ts` orchestration end to end. Jobs:

| Job | Verifies |
|---|---|
| `implement` | `workflow_dispatch` + prompt opens a real PR; `status=success`; `result_json` and the `deep-agent-run` artifact are well-formed. |
| `approval-gate` | `require_push_approval: true` lands the change as a **draft** PR with `approvalPending`. |

Review mode is covered by unit tests (`test/review.test.ts`); GitHub forbids overriding `GITHUB_EVENT_*` on the runner, so a PR-attached event can't be synthesized into the live entrypoint.

How to run: **Actions → E2E → Run workflow** (it also runs nightly). It needs the `PROVIDER_API_KEY` repository secret (defaults to `openai:gpt-4o-mini`); when the secret is absent every job **skips cleanly** rather than failing. Each run makes a few tiny model calls — cents. The harness helpers are pure and unit-tested, so you can validate their logic locally without a live run:

```bash
echo '{"status":"success","mode":"agent","model":"x","plan":[],"toolCalls":[],"filesChanged":[]}' \
  | bun run scripts/e2e/assert-result.ts                      # validates a result_json
```

## Making changes

### Add a model provider

1. Add a `case` to the `switch` in [`src/agent/model.ts`](src/agent/model.ts) returning a LangChain chat model.
2. If the provider should be inferable from a bare model name, add a prefix rule to `PROVIDER_BY_PREFIX` in [`src/config.ts`](src/config.ts).
3. Add a price entry to [`src/agent/cost.ts`](src/agent/cost.ts) if you want cost estimates.
4. Document it in [`action.yml`](action.yml) (the `model` input description) and [`docs/providers.md`](docs/providers.md).
5. Add it to the smoke path so CI exercises the import.

### Change inputs

Inputs are declared in [`action.yml`](action.yml) and parsed in [`src/config.ts`](src/config.ts) (`loadConfig`). Keep the three in sync: `action.yml`, `loadConfig`, and the docs tables in `README.md` / `docs/configuration.md`.

### Add a test

Tests use Bun's runner and live in `test/`, one file per module. Prefer pure, unit-testable functions (see how `normalizeModel`, `isPermitted`, `checkContainsTrigger`, and `estimateCostUsd` are tested).

## Pull requests

- Keep changes focused; match the existing code style (Prettier-enforced).
- Update docs and `action.yml` alongside behavior changes.
- Ensure `typecheck`, `test`, `format:check`, and `smoke` all pass.
- Describe what changed and how you tested it (the PR template prompts for this).

## Reporting bugs & requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE/). For security issues, **do not** open a public issue — follow [SECURITY.md](SECURITY.md).

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
