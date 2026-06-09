import { describe, expect, test } from "bun:test";
import { buildShellEnv } from "../src/agent/env.js";

describe("buildShellEnv (secret isolation)", () => {
  const source = {
    PATH: "/custom/bin:/usr/bin",
    HOME: "/home/runner",
    GITHUB_WORKSPACE: "/work",
    // Secrets that must NOT leak into the agent's shell:
    ANTHROPIC_API_KEY: "sk-secret",
    OPENAI_API_KEY: "sk-secret",
    PROVIDER_API_KEY: "sk-secret",
    APP_PRIVATE_KEY: "-----BEGIN-----",
    APP_ID: "123",
    GITHUB_TOKEN: "ghs_secret",
    INPUT_PROMPT: "do something",
  } as NodeJS.ProcessEnv;

  test("includes non-secret toolchain vars", () => {
    const env = buildShellEnv(source);
    expect(env.PATH).toBe("/custom/bin:/usr/bin");
    expect(env.HOME).toBe("/home/runner");
    expect(env.GITHUB_WORKSPACE).toBe("/work");
    expect(env.CI).toBe("true");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("excludes every secret by construction (allow-list)", () => {
    const env = buildShellEnv(source);
    for (const secret of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "PROVIDER_API_KEY",
      "APP_PRIVATE_KEY",
      "APP_ID",
      "GITHUB_TOKEN",
      "INPUT_PROMPT",
    ]) {
      expect(env[secret]).toBeUndefined();
    }
  });

  test("provides a fallback PATH when missing", () => {
    const env = buildShellEnv({} as NodeJS.ProcessEnv);
    expect(env.PATH).toContain("/usr/bin");
  });
});
