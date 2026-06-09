import { describe, expect, test } from "bun:test";
import { normalizeRepoConfig } from "../src/config/repoConfig.js";
import { mergeRepoConfig, DEFAULT_DENIED_COMMANDS } from "../src/config.js";
import type { Config } from "../src/types.js";

describe("normalizeRepoConfig", () => {
  test("maps snake_case YAML keys", () => {
    expect(
      normalizeRepoConfig({
        system_prompt: "be terse",
        allowed_commands: ["git", "make"],
        denied_commands: ["rm"],
        model: "openai:gpt-5",
      }),
    ).toEqual({
      systemPrompt: "be terse",
      allowedCommands: ["git", "make"],
      deniedCommands: ["rm"],
      model: "openai:gpt-5",
    });
  });

  test("ignores unknown/missing keys", () => {
    expect(normalizeRepoConfig({ nope: 1 })).toEqual({});
    expect(normalizeRepoConfig(null)).toEqual({});
  });
});

const base: Config = {
  triggerPhrase: "@agent",
  model: "anthropic:claude-sonnet-4-6",
  allowedPermissions: ["write", "admin"],
  allowedCommands: ["git", "npm"],
  deniedCommands: [...DEFAULT_DENIED_COMMANDS],
  requirePushApproval: false,
  mcpConfig: "",
  shellTimeoutSeconds: 600,
  commentDebounceMs: 8000,
};

describe("mergeRepoConfig", () => {
  test("repo model/allow-list override inputs", () => {
    const merged = mergeRepoConfig(base, { model: "openai:gpt-5", allowedCommands: ["go"] });
    expect(merged.model).toBe("openai:gpt-5");
    expect(merged.allowedCommands).toEqual(["go"]);
  });

  test("built-in deny-list is always preserved (security floor)", () => {
    const merged = mergeRepoConfig(base, { deniedCommands: ["mycmd"] });
    expect(merged.deniedCommands).toContain("curl"); // from DEFAULT_DENIED_COMMANDS
    expect(merged.deniedCommands).toContain("mycmd");
  });

  test("empty repo config is a no-op for commands/model", () => {
    const merged = mergeRepoConfig(base, {});
    expect(merged.model).toBe(base.model);
    expect(merged.allowedCommands).toEqual(base.allowedCommands);
  });
});
