import { describe, expect, test } from "bun:test";
import { sanitizeBranchName, generateBranchName } from "../src/github/ops.js";
import { makeContext } from "./mockContext.js";

describe("sanitizeBranchName", () => {
  test("replaces unsafe characters", () => {
    expect(sanitizeBranchName("feat/Fix Bug! (#12)")).toBe("feat/Fix-Bug-12");
  });
  test("strips leading/trailing separators", () => {
    expect(sanitizeBranchName("--/foo/--")).toBe("foo");
  });
  test("caps length", () => {
    expect(sanitizeBranchName("a".repeat(300)).length).toBe(240);
  });
});

describe("generateBranchName", () => {
  test("issue branch", () => {
    const ctx = makeContext({ isPR: false, entityNumber: 12 });
    expect(generateBranchName(ctx, "987")).toBe("deep-agent/issue-12-987");
  });
  test("dispatch branch when no entity", () => {
    const ctx = makeContext({ isPR: false, entityNumber: undefined });
    expect(generateBranchName(ctx, "5")).toBe("deep-agent/dispatch-5");
  });
});
