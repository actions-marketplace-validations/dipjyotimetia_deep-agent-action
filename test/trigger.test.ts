import { describe, expect, test } from "bun:test";
import { checkContainsTrigger, extractInstruction } from "../src/github/validation/trigger.js";

describe("checkContainsTrigger", () => {
  test("matches the phrase at a word boundary", () => {
    expect(checkContainsTrigger("hey @agent please fix", "@agent")).toBe(true);
    expect(checkContainsTrigger("@agent", "@agent")).toBe(true);
    expect(checkContainsTrigger("@agent, do it", "@agent")).toBe(true);
  });

  test("does not match substrings", () => {
    expect(checkContainsTrigger("@agentic stuff", "@agent")).toBe(false);
    expect(checkContainsTrigger("email me@agentmail", "@agent")).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(checkContainsTrigger("@AGENT go", "@agent")).toBe(true);
  });

  test("handles empty inputs", () => {
    expect(checkContainsTrigger(undefined, "@agent")).toBe(false);
    expect(checkContainsTrigger("@agent", "")).toBe(false);
  });
});

describe("extractInstruction", () => {
  test("returns text after the phrase", () => {
    expect(extractInstruction("@agent fix the bug", "@agent")).toBe("fix the bug");
    // The boundary char after the phrase (here ":") is consumed by the match.
    expect(extractInstruction("please @agent: refactor X", "@agent")).toBe("refactor X");
  });

  test("falls back to whole text when phrase absent", () => {
    expect(extractInstruction("just do the thing", "@agent")).toBe("just do the thing");
  });
});
