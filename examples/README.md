# Examples

Copy any of these into `.github/workflows/` in your repository. Each is self-contained and uses `dipjyotimetia/deep-agent-action@main`.

The only secret you must add for the default model is `PROVIDER_API_KEY`; provider-specific setups may use `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or cloud auth env vars such as AWS credentials, Azure OpenAI vars, or `GOOGLE_APPLICATION_CREDENTIALS`.

| File | What it shows |
|---|---|
| [`agent.yml`](agent.yml) | The all-in-one starting point: implement on issues, fix and review on PRs, plus manual dispatch. |
| [`review.yml`](review.yml) | Read-only code review on pull requests (`@agent review`). |
| [`approval-gate.yml`](approval-gate.yml) | Require human approval before changes land (draft PR / proposed branch). |
| [`multi-provider.yml`](multi-provider.yml) | OpenAI, OpenRouter, OpenAI-compatible, Bedrock, and Vertex AI variants. |
| [`mcp-tools.yml`](mcp-tools.yml) | Extend the agent with MCP servers. |
| [`github-app.yml`](github-app.yml) | Use a GitHub App so the agent's PRs trigger your other CI workflows. |
| [`fork-support.yml`](fork-support.yml) | Allow fork PRs only after a maintainer applies a configured label. |
| [`issue-automation.yml`](issue-automation.yml) | Automate issue-based requests into PRs using `@agent` on issues and issue comments. |

## Optional: per-repo config

Beyond the workflow, you can commit a `.github/deep-agent.yml` to tune the agent per repository (system prompt, model, command lists). See [docs/configuration.md](../docs/configuration.md#per-repo-config-file) for the example, field reference, and merge rules.
