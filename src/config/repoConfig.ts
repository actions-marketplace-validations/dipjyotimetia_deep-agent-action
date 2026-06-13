import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import * as core from "@actions/core";
import { z } from "zod";

/** Per-repo overrides committed to the repository (optional). */
export interface RepoConfig {
  systemPrompt?: string;
  allowedCommands?: string[];
  deniedCommands?: string[];
  model?: string;
}

const CONFIG_PATHS = [".github/deep-agent.yml", ".github/deep-agent.yaml", ".deep-agent.yml"];

/**
 * Schema for the committed YAML (snake_case keys), mapped to a camelCase
 * RepoConfig. Each field is independently `.catch`ed so one malformed value
 * never discards the rest; unknown keys are stripped.
 */
const RepoConfigSchema = z
  .object({
    system_prompt: z.string().optional().catch(undefined),
    allowed_commands: z.array(z.coerce.string()).optional().catch(undefined),
    denied_commands: z.array(z.coerce.string()).optional().catch(undefined),
    model: z.string().optional().catch(undefined),
  })
  .transform((r): RepoConfig => {
    const cfg: RepoConfig = {};
    if (r.system_prompt !== undefined) cfg.systemPrompt = r.system_prompt;
    if (r.allowed_commands !== undefined) cfg.allowedCommands = r.allowed_commands;
    if (r.denied_commands !== undefined) cfg.deniedCommands = r.denied_commands;
    if (r.model !== undefined) cfg.model = r.model;
    return cfg;
  });

/** Coerce a parsed YAML object into a typed RepoConfig (pure, testable). */
export function normalizeRepoConfig(raw: unknown): RepoConfig {
  return RepoConfigSchema.safeParse(raw ?? {}).data ?? {};
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
