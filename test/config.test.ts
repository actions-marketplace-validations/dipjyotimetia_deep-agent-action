import { describe, expect, test } from "bun:test";
import { normalizeModel, parseList, parseBool, parsePositiveNumber } from "../src/config.js";

describe("normalizeModel", () => {
  test("prefixes a bare claude model with anthropic", () => {
    const m = normalizeModel("claude-sonnet-4-5");
    expect(m).toEqual({
      provider: "anthropic",
      name: "claude-sonnet-4-5",
      full: "anthropic:claude-sonnet-4-5",
    });
  });

  test("infers provider from a bare model-name prefix", () => {
    expect(normalizeModel("gpt-5").provider).toBe("openai");
    expect(normalizeModel("o3-mini").provider).toBe("openai");
    expect(normalizeModel("gemini-2.5-pro").provider).toBe("google");
    expect(normalizeModel("mistral-large").provider).toBe("anthropic"); // unknown → default
  });

  test("respects an explicit provider prefix", () => {
    expect(normalizeModel("openai:gpt-5")).toEqual({
      provider: "openai",
      name: "gpt-5",
      full: "openai:gpt-5",
    });
    expect(normalizeModel("openrouter:openai/gpt-4o").name).toBe("openai/gpt-4o");
  });

  test("splits only on the first colon (Bedrock model ids contain colons)", () => {
    const m = normalizeModel("bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(m.provider).toBe("bedrock");
    expect(m.name).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
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

describe("parsePositiveNumber", () => {
  test("returns undefined when unset or blank", () => {
    expect(parsePositiveNumber(undefined, "x")).toBeUndefined();
    expect(parsePositiveNumber("", "x")).toBeUndefined();
    expect(parsePositiveNumber("   ", "x")).toBeUndefined();
  });

  test("parses a valid positive number", () => {
    expect(parsePositiveNumber("5", "x")).toBe(5);
    expect(parsePositiveNumber("0.25", "x")).toBe(0.25);
    expect(parsePositiveNumber(" 200000 ", "x")).toBe(200000);
  });

  test("throws on a malformed value (fails closed, not open)", () => {
    expect(() => parsePositiveNumber("$5", "max_cost_usd")).toThrow("max_cost_usd");
    expect(() => parsePositiveNumber("abc", "x")).toThrow();
    expect(() => parsePositiveNumber("0", "x")).toThrow();
    expect(() => parsePositiveNumber("-3", "x")).toThrow();
  });
});
