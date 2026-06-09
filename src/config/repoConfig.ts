import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import * as core from "@actions/core";

/** Per-repo overrides committed to the repository (optional). */
export interface RepoConfig {
  systemPrompt?: string;
  allowedCommands?: string[];
  deniedCommands?: string[];
  model?: string;
}

const CONFIG_PATHS = [".github/deep-agent.yml", ".github/deep-agent.yaml", ".deep-agent.yml"];

/** Coerce a parsed YAML object into a typed RepoConfig (pure, testable). */
export function normalizeRepoConfig(raw: unknown): RepoConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const cfg: RepoConfig = {};
  if (typeof r.system_prompt === "string") cfg.systemPrompt = r.system_prompt;
  if (Array.isArray(r.allowed_commands)) cfg.allowedCommands = r.allowed_commands.map(String);
  if (Array.isArray(r.denied_commands)) cfg.deniedCommands = r.denied_commands.map(String);
  if (typeof r.model === "string") cfg.model = r.model;
  return cfg;
}

/**
 * Load an optional repo config from the workspace. Missing or invalid files
 * yield `{}` (best-effort) so a malformed config never aborts a run.
 */
export function loadRepoConfig(rootDir: string): RepoConfig {
  for (const rel of CONFIG_PATHS) {
    const path = join(rootDir, rel);
    if (!existsSync(path)) continue;
    try {
      return normalizeRepoConfig(parseYaml(readFileSync(path, "utf8")));
    } catch (err) {
      core.warning(`Ignoring ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }
  return {};
}
