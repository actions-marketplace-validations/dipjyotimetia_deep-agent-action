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

Commit a `.github/deep-agent.yml` to tune the agent for a repository without editing the workflow:

```yaml
# .github/deep-agent.yml
system_prompt: |
  This is a TypeScript monorepo managed with pnpm. Co-locate tests with the code.
model: claude-opus-4-5
allowed_commands: [git, pnpm, node, pytest]
denied_commands: [rm]
```

See [docs/configuration.md](../docs/configuration.md) for the full field reference and merge rules.
