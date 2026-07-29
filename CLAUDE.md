# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **composite GitHub Action** that runs an AI coding agent in-process on the runner. It reacts to `@agent` mentions (and `workflow_dispatch` prompts) on issues/PRs, plans and edits files, runs the repo's toolchain, and opens a PR — or, in review mode, posts inline PR comments. The agent itself is the [`deepagents`](https://www.npmjs.com/package/deepagents) harness on top of LangChain/LangGraph.

## Commands

Runtime is **Bun** (pinned to `1.3.14` in `action.yml`). There is **no build/bundle step** — the action runs `src/index.ts` directly via `bun run`. Never create or commit a `dist/`.

```bash
bun install              # or: bun install --frozen-lockfile (CI)
bun run typecheck        # tsc --noEmit
bun test                 # all unit tests
bun test test/cost.test.ts   # a single test file
bun run format           # prettier --write
bun run format:check     # prettier --check (CI gate)
bun run smoke            # DEEP_AGENT_SMOKE=1 bun run src/index.ts — see below
```

CI (`.github/workflows/ci.yml`) runs typecheck → format:check → test → smoke on every push/PR. Run all four locally before pushing.

**The smoke check is not optional.** `bun run smoke` instantiates every provider model and exits without any network call. It exists to catch the one class of bug that source-run unit tests cannot: provider packages failing to load. Run it after touching dependencies or `src/agent/model.ts`.

## Architecture

### Control-plane pipeline (`src/index.ts`)

`run()` is a single linear orchestration. The agent is sandwiched between gating (before) and landing (after); both are done by this control plane, never by the model:

1. **Parse** the event → normalized `GitHubContext` (`github/context.ts`).
2. **Config merge** — action inputs (`config.ts:loadConfig`) then per-repo `.github/deep-agent.yml` (`config/repoConfig.ts`, applied via `mergeRepoConfig`).
3. **Route** (`modes/detector.ts:detectMode`) → `noop` | `agent` | `review`. No trigger phrase / prompt → exit with no side effects.
4. **Token** — mint a scoped token (`github/auth.ts`): GitHub App installation token if `app_id`/`app_private_key`, else `GITHUB_TOKEN`.
5. **Gate** — fork-PR protection (`github/fork.ts`) → authorization: actor must be human AND have `write`/`admin` (`github/validation/`). Bots are ignored silently; unauthorized actors get a refusal comment.
6. **Acknowledge** — 👀 reaction + create/reuse the sticky tracking comment, and load MCP tools (all in parallel).
7. **Run** — `runImplement` (edit files → commit) or `runReview` (read diff → collect findings).
8. **Land** — `github/ops.ts:landChanges` opens a PR / pushes to the PR branch (or a draft PR / proposed branch when `require_push_approval`); review mode posts inline comments via `github/review.ts`.
9. **Finalize** — update the sticky comment, `emitOutputs` (`outputs.ts`) writes the `result_json` output, job summary, and the `deep-agent-run.json` audit artifact.

### Agent assembly (`src/agent/`)

`createAgent.ts:buildAgent` wires a guarded `LocalShellBackend` (rooted at the workspace, enforcing command policy for the main agent and subagents) + the model + repository-local deepagents memory/skills + mode-specific filesystem tools and permissions + optional MCP tools in implement mode. `stream.ts:runAgentStream` drives it in `"values"` streamMode, mirrors the `todos` plan into the tracking comment (debounced), and records typed main/subagent tool activity and pending interrupts. `recursionLimit` is raised to 150 because a read→edit→test→fix loop exceeds LangGraph's default 25.

### Critical constraints (these are the easy things to break)

- **Static model imports are mandatory.** `agent/model.ts` constructs each LangChain chat model with a *static* import and hands the instance to `createDeepAgent`. Do **not** refactor this to pass a `"provider:model"` string — that path uses LangChain's dynamic `import()`, which fails to resolve at runtime. The smoke check guards this.
- **The agent shell is secret-free by construction.** `agent/env.ts` is an *allow-list* of env var names; provider keys, `GITHUB_TOKEN`, App keys, and `INPUT_*` are excluded, so they can never leak into a model-directed shell command. Don't add secret-bearing names to that list.
- **The built-in command deny-list cannot be weakened.** `mergeRepoConfig` always re-merges `DEFAULT_DENIED_COMMANDS` (`config.ts`), so a committed repo config can narrow the allow-list and add denials but never remove a default denial. `shellGuard.ts` enforces allow/deny per command segment plus a global token scan (for denials hidden in `$(...)`).
- **The agent never runs git/push.** It only edits files in the workspace; all commit/branch/push/PR operations live in `github/ops.ts` and run with the scoped token via `execFileSync("git", ...)` (no shell — injection-safe).
- **Deepagents repository guidance is intentionally narrow.** Only `.deepagents/AGENTS.md` and `.deepagents/skills/` are discovered. Built-in filesystem writes under `.deepagents/` are denied before custom permission rules; issue/PR text stays in a separate user-message data section.
- **Interrupts are safe stops, not durable resumes.** MCP tools are interrupted by default when configured. The action records pending requests, lands partial work through the approval path, and a later `@agent resume` starts a fresh run using sticky-comment memory because the runner has no persistent checkpointer/store.
- **ESM with explicit `.js` import extensions.** Source is `.ts` but imports use `.js` (e.g. `from "./config.js"`). Keep this when adding imports.

### Review-mode handoff

In review mode the agent has no repository edit, shell, or MCP tools. It writes findings to `/review-output/findings.json`, which is routed to temporary storage outside the checkout; the control plane reads and removes that handoff before posting the inline review. Auto-applied suggestions must target contained, non-symlink regular files in GitHub's changed-file list. Editing review behavior usually means touching `agent/createAgent.ts`, the review system prompt (`agent/prompt.ts`), and `github/review.ts`.

## Making changes

- **Adding a provider:** add a `case` to `agent/model.ts`; optionally a bare-name inference rule to `PROVIDER_BY_PREFIX` in `config.ts`; a price entry in `agent/cost.ts`; document in `action.yml` + `docs/providers.md`; and add it to `smoke` (in `index.ts`) so CI exercises the import.
- **Adding/changing an input:** keep three places in sync — `action.yml` (declaration + `INPUT_*` env passthrough), `config.ts:loadConfig`, and the input tables in `README.md` / `docs/configuration.md`. For deepagents policy inputs, also update `config/repoConfig.ts` and its precedence tests.
- **Tests** are one `*.test.ts` per module under `test/`, Bun's runner, no network. Prefer extracting pure functions and testing those (see `normalizeModel`, `checkContainsTrigger`, `evaluateCommand`, `estimateCostUsd`).

Deeper detail — full file map, the live E2E harness (`.github/workflows/e2e.yml`), and the threat model — is in `CONTRIBUTING.md` and `docs/` (`configuration.md`, `providers.md`, `security.md`, `troubleshooting.md`).

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
