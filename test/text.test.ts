import { describe, expect, test } from "bun:test";
import { truncateBody, GITHUB_COMMENT_MAX_CHARS } from "../src/github/text.js";

describe("truncateBody", () => {
  test("returns short bodies unchanged", () => {
    expect(truncateBody("short body", 100)).toBe("short body");
    expect(truncateBody("", 100)).toBe("");
  });

  test("clamps an oversized body to the limit and appends a notice", () => {
    const out = truncateBody("x".repeat(2000), 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain("truncated");
    expect(out.startsWith("xxx")).toBe(true); // cut from the end, not the start
  });

  test("default limit is GitHub's comment maximum", () => {
    const out = truncateBody("y".repeat(GITHUB_COMMENT_MAX_CHARS + 1));
    expect(out.length).toBeLessThanOrEqual(GITHUB_COMMENT_MAX_CHARS);
  });
});
