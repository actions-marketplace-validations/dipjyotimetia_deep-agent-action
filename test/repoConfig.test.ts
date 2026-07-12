import { describe, expect, test } from "bun:test";
import { normalizeRepoConfig } from "../src/config/repoConfig.js";
import { mergeRepoConfig, DEFAULT_DENIED_COMMANDS } from "../src/config.js";
import {
  parseFilesystemPermissions,
  parseHarnessProfile,
  parseInterruptPolicy,
} from "../src/agent/policy.js";
import type { Config } from "../src/types.js";

describe("normalizeRepoConfig", () => {
  test("maps snake_case YAML keys", () => {
    expect(
      normalizeRepoConfig({
        system_prompt: "be terse",
        allowed_commands: ["git", "make"],
        denied_commands: ["rm"],
        model: "openai:gpt-5",
        harness_profile: { systemPromptSuffix: "follow the repo" },
        filesystem_permissions: [{ operations: ["read"], paths: ["/src/**"] }],
        interrupt_on: { publish_release: true },
      }),
    ).toEqual({
      systemPrompt: "be terse",
      allowedCommands: ["git", "make"],
      deniedCommands: ["rm"],
      model: "openai:gpt-5",
      harnessProfile: expect.objectContaining({
        systemPromptSuffix: "follow the repo",
      }),
      filesystemPermissions: [{ operations: ["read"], paths: ["/src/**"] }],
      interruptOn: { publish_release: true },
    });
  });

  test("ignores unknown/missing keys", () => {
    expect(normalizeRepoConfig({ nope: 1 })).toEqual({});
    expect(normalizeRepoConfig(null)).toEqual({});
  });

  test("maps auto_run_label/auto_run_assignee", () => {
    expect(
      normalizeRepoConfig({ auto_run_label: "agent-auto", auto_run_assignee: "deep-agent-bot" }),
    ).toEqual({ autoRunLabel: "agent-auto", autoRunAssignee: "deep-agent-bot" });
  });
});

const base: Config = {
  triggerPhrase: "@agent",
  model: "anthropic:claude-sonnet-4-6",
  allowedPermissions: ["write", "admin"],
  allowedCommands: ["git", "npm"],
  deniedCommands: [...DEFAULT_DENIED_COMMANDS],
  requirePushApproval: false,
  verifiedCommits: false,
  applySuggestions: false,
  enableTriage: false,
  triageAllowedLabels: [],
  mcpConfig: "",
  shellTimeoutSeconds: 600,
  commentDebounceMs: 8000,
  recursionLimit: 150,
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

  test("repo auto_run_label/auto_run_assignee override the action inputs", () => {
    const merged = mergeRepoConfig(base, {
      autoRunLabel: "agent-auto",
      autoRunAssignee: "deep-agent-bot",
    });
    expect(merged.autoRunLabel).toBe("agent-auto");
    expect(merged.autoRunAssignee).toBe("deep-agent-bot");
  });

  test("action policy inputs take precedence over repo defaults", () => {
    const actionHarnessProfile = parseHarnessProfile('{"systemPromptSuffix":"action"}')!;
    const repoHarnessProfile = parseHarnessProfile('{"systemPromptSuffix":"repo"}')!;
    const actionFilesystemPermissions = parseFilesystemPermissions(
      '[{"operations":["read"],"paths":["/action/**"]}]',
    )!;
    const repoFilesystemPermissions = parseFilesystemPermissions(
      '[{"operations":["read"],"paths":["/repo/**"]}]',
    )!;
    const actionInterruptOn = parseInterruptPolicy('{"action_tool":true}')!;
    const repoInterruptOn = parseInterruptPolicy('{"repo_tool":true}')!;
    const actionPolicy = {
      harnessProfile: actionHarnessProfile,
      filesystemPermissions: actionFilesystemPermissions,
      interruptOn: actionInterruptOn,
    };
    const merged = mergeRepoConfig(
      { ...base, ...actionPolicy },
      {
        harnessProfile: repoHarnessProfile,
        filesystemPermissions: repoFilesystemPermissions,
        interruptOn: repoInterruptOn,
      },
    );

    expect(merged.harnessProfile).toBe(actionHarnessProfile);
    expect(merged.filesystemPermissions).toEqual(actionPolicy.filesystemPermissions);
    expect(merged.interruptOn).toEqual(actionPolicy.interruptOn);
  });
});
