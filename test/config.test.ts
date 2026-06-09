import { describe, expect, test } from "bun:test";
import { normalizeModel, parseList, parseBool } from "../src/config.js";

describe("normalizeModel", () => {
  test("prefixes a bare claude model with anthropic", () => {
    const m = normalizeModel("claude-sonnet-4-5");
    expect(m).toEqual({
      provider: "anthropic",
      name: "claude-sonnet-4-5",
      full: "anthropic:claude-sonnet-4-5",
    });
  });

  test("infers openai for a bare gpt model", () => {
    expect(normalizeModel("gpt-5").provider).toBe("openai");
  });

  test("respects an explicit provider prefix", () => {
    const m = normalizeModel("openai:gpt-5");
    expect(m).toEqual({ provider: "openai", name: "gpt-5", full: "openai:gpt-5" });
  });

  test("lower-cases the provider", () => {
    expect(normalizeModel("Anthropic:claude").provider).toBe("anthropic");
  });
});

describe("parseList", () => {
  test("splits on commas and newlines, trims, dedupes", () => {
    expect(parseList("git, npm\npytest, git")).toEqual(["git", "npm", "pytest"]);
  });
  test("returns empty for undefined", () => {
    expect(parseList(undefined)).toEqual([]);
  });
});

describe("parseBool", () => {
  test("is true only for truthy strings", () => {
    expect(parseBool("true")).toBe(true);
    expect(parseBool("TRUE")).toBe(true);
    expect(parseBool("1")).toBe(true);
    expect(parseBool("false")).toBe(false);
    expect(parseBool("")).toBe(false);
    expect(parseBool(undefined)).toBe(false);
  });
});
