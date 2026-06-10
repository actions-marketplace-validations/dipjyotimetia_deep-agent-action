import { describe, expect, test } from "bun:test";
import { validateResult, assertResult } from "../scripts/e2e/assert-result.js";

const valid = {
  status: "success",
  mode: "agent",
  model: "openai:gpt-4o-mini",
  plan: [{ content: "create the file", status: "completed" }],
  toolCalls: [],
  filesChanged: ["demo/HELLO.md"],
  tokens: { input: 100, output: 20 },
  costUsd: 0.0001,
  approvalPending: false,
};

describe("validateResult", () => {
  test("accepts a well-formed RunRecord", () => {
    expect(validateResult(valid)).toEqual({ ok: true, errors: [] });
  });

  test("rejects a non-object", () => {
    expect(validateResult(null).ok).toBe(false);
    expect(validateResult("nope").ok).toBe(false);
  });

  test("rejects an unknown status and an unknown mode", () => {
    expect(validateResult({ ...valid, status: "weird" }).errors.join()).toContain("status");
    expect(validateResult({ ...valid, mode: "weird" }).errors.join()).toContain("mode");
  });

  test("requires plan/toolCalls/filesChanged to be arrays", () => {
    expect(validateResult({ ...valid, plan: "x" }).ok).toBe(false);
    expect(validateResult({ ...valid, filesChanged: 3 }).ok).toBe(false);
  });

  test("rejects malformed optional tokens", () => {
    expect(validateResult({ ...valid, tokens: { input: "x", output: 1 } }).ok).toBe(false);
  });

  test("allows omitting optional fields", () => {
    const minimal = {
      status: "success",
      mode: "review",
      model: "openai:gpt-4o-mini",
      plan: [],
      toolCalls: [],
      filesChanged: [],
    };
    expect(validateResult(minimal).ok).toBe(true);
  });
});

describe("assertResult", () => {
  test("enforces an expected status when provided", () => {
    expect(assertResult(valid, { expectStatus: "success" }).ok).toBe(true);
    const r = assertResult(valid, { expectStatus: "failed" });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("expected status failed");
  });
});
