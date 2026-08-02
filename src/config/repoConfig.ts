import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import * as core from "@actions/core";
import { z } from "zod";

/** Repository-owned guidance appended to the action-owned system prompt. */
export interface RepoConfig {
  systemPrompt?: string;
}

const CONFIG_PATHS = [".github/deep-agent.yml", ".github/deep-agent.yaml", ".deep-agent.yml"];

/**
 * Repository config is deliberately guidance-only. Execution and security
 * policy belong to the workflow owner, not to files an agent can propose.
 */
const RepoConfigSchema = z
  .object({
    system_prompt: z.string().optional().catch(undefined),
  })
  .transform((r): RepoConfig => {
    const cfg: RepoConfig = {};
    if (r.system_prompt !== undefined) cfg.systemPrompt = r.system_prompt;
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
