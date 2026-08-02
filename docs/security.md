# Security model

The agent executes model-generated edits and shell commands inside your runner. This action is built defensively so that an untrusted instruction — or a model that goes off the rails — has a small blast radius. This document describes those controls.

> This is the **security model** (how the action protects itself). To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Threat model in one line

A model-driven agent runs with your runner's permissions. The controls below limit **who can invoke it**, **what it can run**, and **what it can see**. It is a layered guardrail model, **not a sandbox** — run it with providers and on repositories you trust.

## 1. Who can trigger it

Before any agent work begins, two checks must pass (see [`src/github/validation/`](../src/github/validation/)):

- **Human actor.** Bot accounts (`…[bot]`, `github-actions[bot]`, or any non-`User` account type) are rejected. This prevents the action from triggering itself in a loop. — [`actor.ts`](../src/github/validation/actor.ts)
- **Sufficient permission.** The actor's repository permission level must be in `allowed_permissions` (default `write,admin`). `maintain` satisfies a `write` requirement. — [`permissions.ts`](../src/github/validation/permissions.ts)

If either fails, the run refuses and posts a short reason. Outputs report `status: refused`.

## 2. Fork-PR protection

Pull requests **from forks** are the classic attack surface: an untrusted contributor could submit a PR whose body says `@agent exfiltrate secrets`.

- Fork PRs are **denied by default** — if `fork_allow_label` is unset, they never run. — [`src/github/fork.ts`](../src/github/fork.ts)
- A maintainer (write access) can opt in **per PR** by applying the configured `fork_allow_label`. This is an explicit, auditable human decision.

Pair this with GitHub's "Require approval for all outside collaborators" setting on workflow runs for defense in depth.

## 3. Secret-free shell

The agent's shell environment is an **allow-list**, not the runner's full environment. — [`src/agent/env.ts`](../src/agent/env.ts)

- Only non-secret variables are passed through: `PATH`, `HOME`, locale vars, toolchain locations (`GOPATH`, `CARGO_HOME`, …), and non-secret GitHub context (`GITHUB_WORKSPACE`, `GITHUB_SHA`, …).
- **Excluded by construction:** provider API keys, `GITHUB_TOKEN`, the GitHub App private key, and all `INPUT_*` variables. They cannot leak into a model-directed shell command because they are never placed in its environment.
- `GIT_TERMINAL_PROMPT=0` ensures git never blocks on an interactive credential prompt.

## 4. Command guardrails

Every shell command the agent runs is screened at the shared backend boundary, including commands requested by delegated subagents. — [`src/agent/shellGuard.ts`](../src/agent/shellGuard.ts)

- **Allow-list:** only commands on `allowed_commands` (default: a common dev toolchain) may run.
- **Deny-list:** an always-on list (`curl, wget, nc, ncat, ssh, scp, sudo, su, telnet, dd, mkfs, shutdown, reboot`) is blocked even if also allow-listed — the **deny-list always wins**.
- Commands are screened across operator-separated segments (so `make && curl …` is caught), and a per-repo `.github/deep-agent.yml` can strengthen, but never weaken, the deny-list.

> Guardrails reduce risk; they are not a complete jail. A determined model with allow-listed tools can still do unexpected things in the workspace. Keep the allow-list as small as your task needs.

The local shell backend executes allowed commands directly on the runner. The command filter is therefore a policy guardrail, not process, filesystem, or network isolation.

## 5. Human-in-the-loop approval gate

For higher-stakes repositories, require a human to approve before changes land. — [`src/github/ops.ts`](../src/github/ops.ts)

Set `require_push_approval: true`:

- **Issue / dispatch mode:** the change opens as a **draft PR** instead of a ready PR.
- **PR mode:** the change is pushed to a **proposed branch** (`deep-agent/proposed/<n>-<run>`) and the comment includes a **compare link** — nothing is pushed to the PR branch until a human acts.

See [examples/approval-gate.yml](../examples/approval-gate.yml).

## 6. Repository guidance and deepagents policy

The action loads only repository-local `.deepagents/AGENTS.md` and `.deepagents/skills/` sources. Issue, PR, and comment text is supplied separately as untrusted task data; it is not merged into repository guidance.

- `AGENTS.md` is read as always-on context, not as a place to store credentials or task state.
- Deepagents filesystem writes under `/.deepagents/**` are denied before custom permission rules are applied, so a repository config cannot make its own guidance writable through built-in file tools.
- `harness_profile`, `filesystem_permissions`, `interrupt_on`, and `subagents` inputs are strict-validated. Workflow inputs take precedence over repository defaults for these fields. Specialist subagents may only add filesystem deny rules, use repository-local skills, and select MCP tools already loaded for the action.
- The filesystem permission rules do not sandbox shell execution. Keep using the command allow-list, deny-list, and secret-free environment; a real container/jail is required for hard process isolation.

Review mode has a narrower boundary: it exposes read/search tools plus `write_file`, but no `execute` or `edit_file`. Writes are denied everywhere except `/review-output/**`, which is routed to a temporary directory outside the checkout and removed after the findings are consumed. “Review and fix” suggestions are applied by the control plane only to paths returned by GitHub's changed-files API that resolve to contained, non-symlink regular files; rejected suggestions remain review comments.

## 7. Tool interrupts

Configured MCP tools are interrupted before execution by default. A paused request is recorded in the tracking comment and audit output, and the action exits with `status: interrupted`. Because GitHub runners are ephemeral, the action does not claim to resume the exact graph; a fresh `@agent resume` run uses the existing branch and sticky-comment memory.

## 8. Scoped tokens & least privilege

- By default the action uses the workflow's `GITHUB_TOKEN`. Scope it with the `permissions:` block — grant only `contents`, `pull-requests`, and `issues` write as needed.
- For a stronger identity (and to let the agent's PRs trigger CI), configure a **GitHub App**. The action mints a **short-lived, installation-scoped** token via [`@octokit/auth-app`](https://github.com/octokit/auth-app.js). — [`src/github/auth.ts`](../src/github/auth.ts), [examples/github-app.yml](../examples/github-app.yml).

## 9. Auditability

Every run is recorded:

- A **sticky comment** shows the plan, progress, outcome, and token/cost estimate.
- A **job summary** captures the same in the Actions UI.
- `result_json` output and the **`deep-agent-run` artifact** contain the full machine-readable run record (plan, files changed, tokens, cost, status).

## Hardening checklist

- [ ] Keep `permissions:` minimal in the workflow.
- [ ] Leave `fork_allow_label` unset unless you actively triage fork PRs.
- [ ] Trim `allowed_commands` to what your project actually needs.
- [ ] Use `require_push_approval: true` on protected or high-traffic repos.
- [ ] Store provider keys as repository/organization **secrets**, never in the workflow file.
- [ ] Prefer a GitHub App with least-privilege installation scopes over a broad PAT.
