import { describe, expect, test } from "bun:test";
import {
  loadConfig,
  normalizeModel,
  parseList,
  parseBool,
  parsePositiveNumber,
  parsePositiveInteger,
} from "../src/config.js";

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

describe("parsePositiveInteger", () => {
  test("returns undefined when unset", () => {
    expect(parsePositiveInteger(undefined, "recursion_limit")).toBeUndefined();
    expect(parsePositiveInteger("", "recursion_limit")).toBeUndefined();
  });

  test("parses a valid positive integer", () => {
    expect(parsePositiveInteger("150", "recursion_limit")).toBe(150);
    expect(parsePositiveInteger(" 42 ", "recursion_limit")).toBe(42);
  });

  test("throws on fractional, zero, negative, or malformed values", () => {
    expect(() => parsePositiveInteger("1.5", "recursion_limit")).toThrow("recursion_limit");
    expect(() => parsePositiveInteger("0", "recursion_limit")).toThrow();
    expect(() => parsePositiveInteger("-2", "recursion_limit")).toThrow();
    expect(() => parsePositiveInteger("many", "recursion_limit")).toThrow();
  });
});

describe("loadConfig recursion limit", () => {
  test("defaults to 150 and honors INPUT_RECURSION_LIMIT", () => {
    delete process.env.INPUT_RECURSION_LIMIT;
    expect(loadConfig().recursionLimit).toBe(150);
    process.env.INPUT_RECURSION_LIMIT = "400";
    try {
      expect(loadConfig().recursionLimit).toBe(400);
    } finally {
      delete process.env.INPUT_RECURSION_LIMIT;
    }
  });
});

describe("loadConfig repeated tool-call limit", () => {
  test("defaults to 8, honors an override, and rejects invalid values", () => {
    delete process.env.INPUT_MAX_REPEATED_TOOL_CALLS;
    expect(loadConfig().maxRepeatedToolCalls).toBe(8);
    process.env.INPUT_MAX_REPEATED_TOOL_CALLS = "12";
    expect(loadConfig().maxRepeatedToolCalls).toBe(12);
    process.env.INPUT_MAX_REPEATED_TOOL_CALLS = "0";
    expect(() => loadConfig()).toThrow("max_repeated_tool_calls");
    delete process.env.INPUT_MAX_REPEATED_TOOL_CALLS;
  });
});

describe("loadConfig runner timing inputs", () => {
  test("rejects non-positive or fractional shell timeouts and comment debounce values", () => {
    process.env.INPUT_SHELL_TIMEOUT_SECONDS = "-1";
    expect(() => loadConfig()).toThrow("shell_timeout_seconds");
    delete process.env.INPUT_SHELL_TIMEOUT_SECONDS;

    process.env.INPUT_COMMENT_DEBOUNCE_MS = "1.5";
    try {
      expect(() => loadConfig()).toThrow("comment_debounce_ms");
    } finally {
      delete process.env.INPUT_COMMENT_DEBOUNCE_MS;
    }
  });
});

describe("loadConfig deepagents policy", () => {
  test("loads strict profile, permission, and interrupt JSON inputs", () => {
    process.env.INPUT_HARNESS_PROFILE = JSON.stringify({
      systemPromptSuffix: "Use the repository conventions.",
    });
    process.env.INPUT_FILESYSTEM_PERMISSIONS = JSON.stringify([
      { operations: ["read"], paths: ["/src/**"] },
    ]);
    process.env.INPUT_INTERRUPT_ON = JSON.stringify({ publish_release: true });

    try {
      const config = loadConfig();
      expect(config.harnessProfile?.systemPromptSuffix).toBe("Use the repository conventions.");
      expect(config.filesystemPermissions).toEqual([{ operations: ["read"], paths: ["/src/**"] }]);
      expect(config.interruptOn).toEqual({ publish_release: true });
    } finally {
      delete process.env.INPUT_HARNESS_PROFILE;
      delete process.env.INPUT_FILESYSTEM_PERMISSIONS;
      delete process.env.INPUT_INTERRUPT_ON;
    }
  });
});
