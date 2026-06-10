# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, report privately using one of:

- **GitHub Security Advisories** — open a private report via the repository's [**Security → Advisories → Report a vulnerability**](https://github.com/dipjyotimetia/deep-agent-action/security/advisories/new) page. (Preferred.)
- **Email** — dipjyotimetia@gmail.com.

Please include, where possible:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected version / commit and configuration.
- Any suggested remediation.

We will acknowledge your report, keep you updated on progress, and credit you in the advisory once a fix is released (unless you prefer to remain anonymous).

## Scope

This action runs a model-driven agent that executes commands in your runner. Reports we're especially interested in:

- Bypasses of the **authorization** checks (permission gating, human-actor check).
- Bypasses of **fork-PR protection** or the **shell command** allow/deny guardrails.
- **Secret exposure** — any way provider keys, the `GITHUB_TOKEN`, or the GitHub App key reach the agent's shell or logs.
- **Token/privilege escalation** via the minted GitHub App installation token.

Please review the [security model](docs/security.md) first — several behaviors that look risky (e.g. the agent running shell commands) are intentional and bounded by guardrails. The model is a layered guardrail, **not a sandbox**; running untrusted instructions on an untrusted provider is out of scope.

## Supported versions

This project is pre-1.0. Security fixes are applied to the latest `main`. Pin to a commit SHA for reproducible deployments (see [Versioning](README.md#versioning)).

## Best practices for operators

See the [hardening checklist](docs/security.md#hardening-checklist): keep workflow `permissions:` minimal, store keys as secrets, trim `allowed_commands`, leave fork PRs disabled unless triaged, and consider `require_push_approval` on protected repos.
