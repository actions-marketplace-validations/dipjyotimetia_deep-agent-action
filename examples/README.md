# Examples

Copy any of these into `.github/workflows/` in your repository. Each is self-contained and uses `dipjyotimetia/deep-agent-action@main`. The only secret you must add for the default model is `PROVIDER_API_KEY`.

| File | What it shows |
|---|---|
| [`agent.yml`](agent.yml) | The all-in-one starting point: implement on issues, fix and review on PRs, plus manual dispatch. |
| [`review.yml`](review.yml) | Read-only code review on pull requests (`@agent review`). |
| [`approval-gate.yml`](approval-gate.yml) | Require human approval before changes land (draft PR / proposed branch). |
| [`multi-provider.yml`](multi-provider.yml) | OpenAI, OpenRouter, OpenAI-compatible, Bedrock, and Vertex AI variants. |
| [`mcp-tools.yml`](mcp-tools.yml) | Extend the agent with MCP servers. |
| [`github-app.yml`](github-app.yml) | Use a GitHub App so the agent's PRs trigger your other CI workflows. |

## Optional: per-repo config

Beyond the workflow, you can commit a `.github/deep-agent.yml` to tune the agent per repository (system prompt, model, command lists). See [docs/configuration.md](../docs/configuration.md#per-repo-config-file) for the example, field reference, and merge rules.
