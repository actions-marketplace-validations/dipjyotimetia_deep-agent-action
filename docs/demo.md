# Demo

See the agent open a real pull request on this repository, end to end.

## Run it

1. Add your model provider key as the `PROVIDER_API_KEY` repository secret (**Settings → Secrets and variables → Actions**). The demo defaults to `openai:gpt-4o-mini`.
2. Go to **Actions → Demo → Run workflow**.
3. Optionally edit the **prompt** (what the agent should build) and **model**, then run.
4. Watch the run. When it finishes, the job summary links the pull request the agent opened.

The demo leaves the PR open so you can browse the diff. Close it when you're done.

> Want it driven by comments instead? Copy [`examples/agent.yml`](../examples/agent.yml) into `.github/workflows/` and type `@agent <instruction>` on an issue or PR.

## What you'll see

While the agent works, it maintains a single sticky tracking comment that updates in place:

```text
### 🤖 Deep Agent

Working on it…

**Plan**
- [x] Inspect the repository layout
- [ ] ⏳ Create demo/BANNER.txt
- [ ] Add a note to demo/README.md
```

When it's done:

```text
### 🤖 Deep Agent

✅ Done.

**Plan**
- [x] Inspect the repository layout
- [x] Create demo/BANNER.txt
- [x] Add a note to demo/README.md

Added an ASCII-art banner and a short note describing it.

**Pull request:** https://github.com/dipjyotimetia/deep-agent-action/pull/123

_Tokens: 4,210 in / 980 out (~$0.0012)_

[View run](https://github.com/dipjyotimetia/deep-agent-action/actions/runs/...)
```

> See the agent in action by running the [Demo workflow](#run-it) — the job summary links the PR once it finishes.

## Machine-readable result

Every run also emits a `result_json` output and a `deep-agent-run` artifact — the full audit record:

```json
{
  "status": "success",
  "mode": "agent",
  "model": "openai:gpt-4o-mini",
  "instruction": "Create demo/BANNER.txt ...",
  "plan": [{ "content": "Create demo/BANNER.txt", "status": "completed" }],
  "toolCalls": [{ "name": "write_file" }],
  "filesChanged": ["demo/BANNER.txt", "demo/README.md"],
  "prUrl": "https://github.com/dipjyotimetia/deep-agent-action/pull/123",
  "branch": "deep-agent/dispatch-1234567890",
  "tokens": { "input": 4210, "output": 980 },
  "costUsd": 0.0012
}
```

## How the live test harness works

The same machinery powers the [`E2E` workflow](../.github/workflows/e2e.yml), which verifies the action against this repo on every nightly run (and on demand). See the [Testing section in CONTRIBUTING](../CONTRIBUTING.md#testing) for what each job asserts and how to run it.
