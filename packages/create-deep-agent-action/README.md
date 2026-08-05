# create-deep-agent-action

Create a secure starter workflow for [Deep Agent Action](https://github.com/dipjyotimetia/deep-agent-action).

```sh
npx create-deep-agent-action
```

The command writes `.github/workflows/deep-agent.yml` and, unless disabled, a minimal `.deepagents/AGENTS.md` guidance file. It never writes secrets or changes GitHub repository settings. Add `PROVIDER_API_KEY` in the repository's Actions secrets after setup.

The generated workflow includes issue reopen and label events, so it is ready to opt into the action's label-backed triage lifecycle. The lifecycle remains disabled until you set `enable_triage: true` and create its configured `triage: …` labels in the target repository.

Use `--help` to see non-interactive options. Existing generated files are preserved unless `--force` is supplied.
