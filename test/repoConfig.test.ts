import { describe, expect, test } from "bun:test";
import { normalizeRepoConfig } from "../src/config/repoConfig.js";

describe("normalizeRepoConfig", () => {
  test("keeps only repository guidance", () => {
    expect(
      normalizeRepoConfig({
        system_prompt: "be terse",
        model: "openai:gpt-5",
        allowed_commands: ["git", "make"],
        interrupt_on: { publish_release: true },
        subagents: [{ name: "release-reviewer" }],
      }),
    ).toEqual({ systemPrompt: "be terse" });
  });

  test("ignores unknown, missing, and malformed guidance", () => {
    expect(normalizeRepoConfig({ nope: 1 })).toEqual({});
    expect(normalizeRepoConfig({ system_prompt: 42 })).toEqual({});
    expect(normalizeRepoConfig(null)).toEqual({});
  });
});
