import { describe, expect, test } from "bun:test";
import { truncateBody, GITHUB_COMMENT_MAX_CHARS } from "../src/github/text.js";
import { renderMemoryBlock, parseMemory, type MemoryTurn } from "../src/github/memory.js";

const MARKER = "<!-- deep-agent:tracking -->";

describe("truncateBody", () => {
  test("returns short bodies unchanged", () => {
    const body = `${MARKER}\n### 🤖 Deep Agent\n\nWorking on it…`;
    expect(truncateBody(body)).toBe(body);
    expect(truncateBody("", 100)).toBe("");
  });

  test("clamps an oversized body to the limit", () => {
    const body = `${MARKER}\n${"x".repeat(2000)}`;
    const out = truncateBody(body, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain("truncated");
  });

  test("default limit is GitHub's comment maximum", () => {
    const body = "y".repeat(GITHUB_COMMENT_MAX_CHARS + 1);
    expect(truncateBody(body).length).toBeLessThanOrEqual(GITHUB_COMMENT_MAX_CHARS);
  });

  test("the leading tracking marker survives (cut from the end, never the start)", () => {
    const body = `${MARKER}\n${"long ".repeat(1000)}`;
    const out = truncateBody(body, 300);
    expect(out.startsWith(MARKER)).toBe(true);
  });

  test("a trailing memory block survives intact and round-trips through parseMemory", () => {
    const turns: MemoryTurn[] = [
      { instruction: "add a flag", summary: "added --verbose", prUrl: "https://x/pull/1" },
    ];
    const block = renderMemoryBlock(turns);
    const body = `${MARKER}\n${"filler ".repeat(500)}\n\n${block}`;
    const out = truncateBody(body, 800);
    expect(out.length).toBeLessThanOrEqual(800);
    expect(out.endsWith(block)).toBe(true);
    expect(parseMemory(out)).toEqual(turns);
    expect(out.startsWith(MARKER)).toBe(true);
  });

  test("drops the memory block when it alone would exceed the limit", () => {
    const turns: MemoryTurn[] = [{ instruction: "i".repeat(400), summary: "s".repeat(400) }];
    const block = renderMemoryBlock(turns);
    const body = `${MARKER}\nvisible text\n\n${block}`;
    const limit = Math.floor(block.length / 2);
    const out = truncateBody(body, limit);
    expect(out.length).toBeLessThanOrEqual(limit);
    expect(parseMemory(out)).toEqual([]);
  });
});
