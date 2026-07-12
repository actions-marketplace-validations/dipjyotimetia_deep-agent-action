import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import * as core from "@actions/core";
import { z } from "zod";
import {
  parseFilesystemPermissionsValue,
  parseHarnessProfileValue,
  parseInterruptPolicyValue,
} from "../agent/policy.js";
import type { InterruptPolicy } from "../agent/policy.js";
import type { FilesystemPermission, HarnessProfile } from "deepagents";

/** Per-repo overrides committed to the repository (optional). */
export interface RepoConfig {
  systemPrompt?: string;
  allowedCommands?: string[];
  deniedCommands?: string[];
  model?: string;
  autoRunLabel?: string;
  autoRunAssignee?: string;
  harnessProfile?: HarnessProfile;
  filesystemPermissions?: FilesystemPermission[];
  interruptOn?: InterruptPolicy;
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
    auto_run_label: z.string().optional().catch(undefined),
    auto_run_assignee: z.string().optional().catch(undefined),
    harness_profile: z.unknown().optional().catch(undefined),
    filesystem_permissions: z.unknown().optional().catch(undefined),
    interrupt_on: z.unknown().optional().catch(undefined),
  })
  .transform((r): RepoConfig => {
    const cfg: RepoConfig = {};
    if (r.system_prompt !== undefined) cfg.systemPrompt = r.system_prompt;
    if (r.allowed_commands !== undefined) cfg.allowedCommands = r.allowed_commands;
    if (r.denied_commands !== undefined) cfg.deniedCommands = r.denied_commands;
    if (r.model !== undefined) cfg.model = r.model;
    if (r.auto_run_label !== undefined) cfg.autoRunLabel = r.auto_run_label;
    if (r.auto_run_assignee !== undefined) cfg.autoRunAssignee = r.auto_run_assignee;
    if (r.harness_profile !== undefined) {
      try {
        cfg.harnessProfile = parseHarnessProfileValue(r.harness_profile, "harness_profile");
      } catch {
        // A malformed repository override is ignored by design; workflow inputs
        // remain authoritative and the rest of the repo config still applies.
      }
    }
    if (r.filesystem_permissions !== undefined) {
      try {
        cfg.filesystemPermissions = parseFilesystemPermissionsValue(
          r.filesystem_permissions,
          "filesystem_permissions",
        );
      } catch {
        // See the harness-profile note above.
      }
    }
    if (r.interrupt_on !== undefined) {
      try {
        cfg.interruptOn = parseInterruptPolicyValue(r.interrupt_on, "interrupt_on");
      } catch {
        // See the harness-profile note above.
      }
    }
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
