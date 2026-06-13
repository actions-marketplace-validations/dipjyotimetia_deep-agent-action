import * as core from "@actions/core";
import type { Config } from "./types.js";
import type { RepoConfig } from "./config/repoConfig.js";

/** Default shell commands the agent is allowed to run. */
export const DEFAULT_ALLOWED_COMMANDS = [
  "git",
  "ls",
  "cat",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "python",
  "python3",
  "pip",
  "pytest",
  "go",
  "make",
  "cargo",
  "rustc",
  "sed",
  "grep",
  "find",
  "echo",
];

/** Shell commands that are always blocked, even if the allow-list would permit them. */
export const DEFAULT_DENIED_COMMANDS = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "ssh",
  "scp",
  "sudo",
  "su",
  "telnet",
  "dd",
  "mkfs",
  "shutdown",
  "reboot",
];

/**
 * Normalize a model id into a provider-prefixed form.
 * `claude-sonnet-4-5` -> `{ provider: "anthropic", name: "claude-sonnet-4-5", full: "anthropic:claude-sonnet-4-5" }`
 * `openai:gpt-5` -> `{ provider: "openai", name: "gpt-5", full: "openai:gpt-5" }`
 */
/** Bare-model-name prefix → provider inference (when no explicit `provider:` prefix). */
const PROVIDER_BY_PREFIX: ReadonlyArray<[RegExp, string]> = [
  [/^claude/i, "anthropic"],
  [/^(gpt|o\d)/i, "openai"],
  [/^gemini/i, "google"],
];

export function normalizeModel(raw: string): {
  provider: string;
  name: string;
  full: string;
} {
  const trimmed = (raw || "").trim();
  const idx = trimmed.indexOf(":");
  if (idx > 0) {
    const provider = trimmed.slice(0, idx).toLowerCase();
    const name = trimmed.slice(idx + 1);
    return { provider, name, full: `${provider}:${name}` };
  }
  // No provider prefix: infer from the model-name prefix, defaulting to anthropic.
  const provider = PROVIDER_BY_PREFIX.find(([re]) => re.test(trimmed))?.[1] ?? "anthropic";
  return { provider, name: trimmed, full: `${provider}:${trimmed}` };
}

/** Parse a boolean input without throwing on empty/missing values. */
export function parseBool(raw: string | undefined): boolean {
  return /^(true|1|yes)$/i.test((raw ?? "").trim());
}

/** Parse a comma/newline-separated list into a trimmed, de-duplicated array. */
export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** Read an input, falling back to a list of environment variable names. */
function inputOrEnv(name: string, envNames: string[]): string {
  const fromInput = core.getInput(name);
  if (fromInput) return fromInput;
  for (const e of envNames) {
    const v = process.env[e];
    if (v) return v;
  }
  return "";
}

/** Load and normalize action inputs from the environment. */
export function loadConfig(): Config {
  const allowedCommands = parseList(core.getInput("allowed_commands"));
  const deniedCommands = parseList(core.getInput("denied_commands"));

  return {
    triggerPhrase: core.getInput("trigger_phrase") || "@agent",
    prompt: core.getInput("prompt") || undefined,
    model: normalizeModel(core.getInput("model") || "claude-sonnet-4-6").full,
    baseUrl: core.getInput("base_url") || undefined,
    allowedPermissions: parseList(core.getInput("allowed_permissions") || "write,admin"),
    allowedCommands: allowedCommands.length ? allowedCommands : DEFAULT_ALLOWED_COMMANDS,
    deniedCommands: [...DEFAULT_DENIED_COMMANDS, ...deniedCommands],
    forkAllowLabel: core.getInput("fork_allow_label") || undefined,
    requirePushApproval: parseBool(core.getInput("require_push_approval")),
    mcpConfig: core.getInput("mcp_config") || "",
    shellTimeoutSeconds: Number(core.getInput("shell_timeout_seconds")) || 600,
    commentDebounceMs: Number(core.getInput("comment_debounce_ms")) || 8000,
    maxCostUsd: Number(core.getInput("max_cost_usd")) || undefined,
    maxTotalTokens: Number(core.getInput("max_total_tokens")) || undefined,
  };
}

/**
 * Apply per-repo overrides on top of the input-derived config. A repo file may
 * narrow/extend the allow-list and change the model, but the built-in
 * deny-list is always re-merged so a committed config cannot weaken it.
 */
export function mergeRepoConfig(base: Config, repo: RepoConfig): Config {
  return {
    ...base,
    model: repo.model ? normalizeModel(repo.model).full : base.model,
    allowedCommands: repo.allowedCommands?.length ? repo.allowedCommands : base.allowedCommands,
    deniedCommands: [...new Set([...base.deniedCommands, ...(repo.deniedCommands ?? [])])],
  };
}

/** Resolve the provider API key from input/env. */
export function resolveProviderApiKey(): string {
  return inputOrEnv("provider_api_key", [
    "PROVIDER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY",
  ]);
}
