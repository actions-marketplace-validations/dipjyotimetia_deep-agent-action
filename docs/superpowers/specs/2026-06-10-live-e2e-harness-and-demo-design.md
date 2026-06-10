# Design: Live E2E Test Harness & Showcase Demo

**Date:** 2026-06-10
**Status:** Approved (design); pending spec review
**Repo:** `dipjyotimetia/deep-agent-action`

## Context

The action ships with 82 unit tests (`bun test`) covering *pure functions* module-by-module: routing (`detector`), trigger parsing, permission/actor checks, fork gating, cost estimation, comment rendering. What they do **not** cover is the end-to-end orchestration in `src/index.ts` — the real flow of routing → auth → fork-gating → agent → git/land → tracking comment → outputs against a live model and the GitHub API.

This design adds a **live end-to-end test harness** that drives the action exactly as shipped against this repository with a real model, asserting real effects (PRs opened, drafts created, reviews posted, outputs/artifact produced) and cleaning up after itself. It also adds a **showcase demo** that runs the agent on a visible task and leaves a real PR for viewing.

### Decisions (confirmed with user)

- **Harness type:** live E2E (real model + real repo), not deterministic fakes.
- **Target & trigger:** this repository; `workflow_dispatch` (manual) + nightly `schedule`; gated so it skips when the provider secret is absent.
- **Provider/model:** `openai:gpt-4o-mini`, key supplied via the `PROVIDER_API_KEY` secret.
- **Coverage:** implement → opens PR; approval gate → draft PR; review mode; outputs + audit artifact.
- **Demo:** showcase `workflow_dispatch` workflow that opens a real PR (left open) + a `docs/demo.md` walkthrough + a README GIF placeholder.

### Key finding: no `src/` changes required

The action already supports every path the harness needs:

- `workflow_dispatch` yields `entityNumber = undefined`; `createTrackingComment`/`findTrackingComment`/`addEyesReaction` all guard `if (entityNumber == null) return` (`src/github/comments.ts:90,130,116`). The agent runs and `landChanges` opens a PR with **no crash** and no tracking comment.
- Approval gate: `landChanges` opens a **draft PR** (`draft: requireApproval`, `src/github/ops.ts:150`) and returns `approvalPending: true`.
- Review: `parseContext` derives `isPR` from `issue.pull_request` in the event payload; `resolvePrRefs` (`src/index.ts:49`) fetches the head ref via API. Both can be driven by a synthetic event file. The action reads the event from `GITHUB_EVENT_PATH` regardless of how it was produced.

## Architecture

Three new workflows + two small harness scripts + docs. The existing unit tests remain the deterministic layer (refusal/fork/routing paths are covered there and are awkward to exercise live).

```
.github/workflows/
  e2e.yml      preflight → {implement, approval-gate, review}  (dispatch + nightly)
  demo.yml     showcase (dispatch only, leaves PR open)
scripts/e2e/
  build-review-event.mjs   emit synthetic issue_comment event JSON from env
  assert-result.mjs        validate result_json shape (plan/tokens/cost/status)
docs/
  demo.md      walkthrough + sample output + GIF placeholder
README.md, CONTRIBUTING.md   Demo + Testing sections (edits)
```

## Component: `e2e.yml`

Triggers: `workflow_dispatch` and nightly `schedule` (cron). `concurrency` group cancels/queues overlapping runs. Job-level `permissions: contents/pull-requests/issues: write`. Default model `openai:gpt-4o-mini`.

### `preflight` job
Secrets cannot be used in `if:` directly. This job reads the secret into an env var and emits an output:

```yaml
preflight:
  outputs:
    has_key: ${{ steps.c.outputs.has_key }}
  steps:
    - id: c
      env: { KEY: ${{ secrets.PROVIDER_API_KEY }} }
      run: |
        if [ -n "$KEY" ]; then echo "has_key=true" >> "$GITHUB_OUTPUT";
        else echo "has_key=false" >> "$GITHUB_OUTPUT"; fi
```

All downstream jobs declare `needs: preflight` and `if: needs.preflight.outputs.has_key == 'true'`, so no-key/fork runs **skip cleanly** rather than fail.

### `implement` job
- `actions/checkout@v6` (`fetch-depth: 0`).
- `uses: ./` with `id: agent`, `model: openai:gpt-4o-mini`, `prompt: "Create a file demo/HELLO.md containing a single greeting line."`, `env: PROVIDER_API_KEY`.
- Assert: `steps.agent.outputs.status == 'success'` and `steps.agent.outputs.pr_url` non-empty (bash, fail otherwise).
- Outputs+artifact coverage: `actions/download-artifact@v4` for `deep-agent-run`, then `node scripts/e2e/assert-result.mjs <file>` to validate `result_json` fields. (Also validate `steps.agent.outputs.result_json` parses.)
- Cleanup (always): derive PR number from `pr_url`, `gh pr close <n> --delete-branch`.

### `approval-gate` job
- Same setup; `uses: ./` with `require_push_approval: "true"` and a prompt.
- Assert: PR is a draft — `gh pr view <n> --json isDraft -q .isDraft == true` — and `result_json.approvalPending == true`.
- Cleanup as above.

### `review` job (Option A — synthetic event)
1. Create a throwaway branch with a small change; `gh pr create` → capture PR number and head ref.
2. `node scripts/e2e/build-review-event.mjs` writes `event.json`: an `issue_comment` payload with `action: created`, `issue.number = <pr#>`, `issue.pull_request = {}` (marks it a PR), `comment.id`, `comment.body = "@agent review"`.
3. Run the action directly for full env control: `bun install --production` then `bun run src/index.ts`, with step env:
   `GITHUB_EVENT_NAME=issue_comment`, `GITHUB_EVENT_PATH=$PWD/event.json`, `GITHUB_ACTOR=${{ github.repository_owner }}`, `INPUT_MODEL=openai:gpt-4o-mini`, `PROVIDER_API_KEY`, `GITHUB_TOKEN`.
   The action fetches the PR head via API, checks it out, runs the real model, and posts a real inline review.
4. Assert: `gh api repos/{owner}/{repo}/pulls/<n>/reviews` returns ≥1 review (or review comments exist).
5. Cleanup: `gh pr close <n> --delete-branch`.

`GITHUB_ACTOR` is set to `github.repository_owner` (a human user with admin on this user-owned repo), so the actor (human) and permission (admin) checks pass.

## Component: `demo.yml`

`workflow_dispatch` only. Inputs: `prompt` (default a fun, visible task such as adding an ASCII-art banner under `demo/`), `model` (default `openai:gpt-4o-mini`). Steps: checkout → `uses: ./` with the inputs and `PROVIDER_API_KEY`. **No cleanup** — the PR is the showcase. A final step writes a `$GITHUB_STEP_SUMMARY` panel linking the PR (`pr_url` output). A guard step fails with a clear message if `PROVIDER_API_KEY` is empty.

## Component: harness scripts (`scripts/e2e/`)

Small, dependency-free Node ESM (Bun-runnable):

- **`build-review-event.mjs`** — reads `PR_NUMBER`, `COMMENT_BODY`, `COMMENT_ID` from env; writes the synthetic `issue_comment` event JSON to a path (arg or stdout). Pure string/JSON assembly.
- **`assert-result.mjs`** — reads a `result_json` file/string; asserts required keys (`status`, `mode`, `model`, `plan` array, `filesChanged` array; `tokens`/`costUsd` when present); exits non-zero with a readable message on failure.

These keep the YAML readable and the assertions independently runnable.

## Component: docs

- **`docs/demo.md`** — trigger instructions; annotated example of the tracking-comment lifecycle (working → done); a sample `result_json`; a placeholder for a recorded GIF; a short "how the e2e harness works" subsection.
- **README** — a **Demo** section (link the demo workflow + `docs/demo.md`, GIF placeholder) and an e2e workflow badge near the CI badge.
- **CONTRIBUTING.md** — a **Testing** section: unit (`bun test`) vs. live e2e (what it does, how to run via *Actions → E2E → Run workflow*, the `PROVIDER_API_KEY` secret requirement, and a cost note).

## Error handling & safety

- All live jobs gated on `has_key`; absent secret → skip (e2e) or clear failure (demo).
- Cleanup steps use `if: always()` so a failed assertion still closes the PR and deletes the branch (no PR buildup from nightly runs).
- `concurrency` prevents overlapping nightly/manual runs racing on branches.
- Tiny prompts on `gpt-4o-mini` keep nightly cost at cents.
- PRs are opened with the default `GITHUB_TOKEN` (won't trigger other CI — fine, they're closed immediately).

## Testing the harness itself

- `scripts/e2e/*.mjs` are pure and get small `bun test` unit tests (event shape; validator accept/reject) so the harness logic is covered without needing a live run.
- All new YAML validated with the existing `python3 -c "import yaml…"` check.

## Alternatives considered

- **Deterministic fakes in CI** (fake model + mocked Octokit): rejected by user in favor of live realism; would also require an injection seam in `index.ts`.
- **Review via dogfood + poll (Option B):** add a live `agent.yml`, post a real `@agent review` comment, poll the triggered run. Requires a PAT secret (GITHUB_TOKEN comments don't trigger workflows; App tokens post as a bot and are rejected by the human-actor check), is slower/flakier, and makes the action permanently active on the repo. Rejected in favor of Option A.

## Out of scope

- No `src/` changes.
- No second/sandbox repo.
- Live coverage of refusal/fork/no-op paths (kept in unit tests).
- Recording the actual GIF (needs a live key run by the maintainer).
