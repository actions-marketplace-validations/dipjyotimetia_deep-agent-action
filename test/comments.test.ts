import { describe, expect, test } from "bun:test";
import {
  renderTrackingBody,
  truncateTrackingBody,
  parseTrackingStatus,
} from "../src/github/comments.js";
import { parseMemory, type MemoryTurn } from "../src/github/memory.js";

describe("renderTrackingBody", () => {
  test("renders the plan as a checklist with status markers", () => {
    const body = renderTrackingBody({
      status: "working",
      instruction: "fix bug",
      todos: [
        { content: "Read the code", status: "completed" },
        { content: "Apply fix", status: "in_progress" },
        { content: "Run tests", status: "pending" },
      ],
    });
    expect(body).toContain("**Plan**");
    expect(body).toContain("- [x] Read the code");
    expect(body).toContain("- [ ] ⏳ Apply fix");
    expect(body).toContain("- [ ] Run tests");
  });

  test("shows the PR link on success", () => {
    const body = renderTrackingBody({
      status: "success",
      prUrl: "https://github.com/acme/widgets/pull/3",
    });
    expect(body).toContain("✅");
    expect(body).toContain("https://github.com/acme/widgets/pull/3");
  });

  test("shows the error on failure", () => {
    const body = renderTrackingBody({ status: "failed", error: "boom" });
    expect(body).toContain("❌");
    expect(body).toContain("boom");
  });

  test("shows a refusal", () => {
    const body = renderTrackingBody({ status: "refused", error: "not authorized" });
    expect(body).toContain("⛔");
    expect(body).toContain("not authorized");
  });

  test("embeds the sticky-comment marker", () => {
    expect(renderTrackingBody({ status: "working" })).toContain("<!-- deep-agent:tracking -->");
  });

  test("renders an approval-pending draft PR differently", () => {
    const body = renderTrackingBody({
      status: "success",
      prUrl: "https://github.com/acme/widgets/pull/3",
      approvalPending: true,
    });
    expect(body).toContain("awaiting approval");
  });

  test("renders token usage and cost", () => {
    const body = renderTrackingBody({
      status: "success",
      tokens: { input: 100, output: 50 },
      costUsd: 0.0012,
    });
    expect(body).toContain("100 in / 50 out");
    expect(body).toContain("$0.0012");
  });

  test("shows the early-stop banner matching the reason", () => {
    expect(renderTrackingBody({ status: "success", stopReason: "budget" })).toContain("budget cap");
    expect(renderTrackingBody({ status: "success", stopReason: "timeout" })).toContain(
      "max runtime",
    );
    expect(renderTrackingBody({ status: "success" })).not.toContain("⚠️");
  });

  test("renders a paused tool approval and the rerun instruction", () => {
    const body = renderTrackingBody({
      status: "interrupted",
      stopReason: "interrupt",
      interrupts: [{ name: "publish_release", args: { tag: "v1.2.3" } }],
      branch: "deep-agent/issue-3",
    });
    expect(body).toContain("Paused");
    expect(body).toContain("publish_release");
    expect(body).toContain("@agent resume");
    expect(body).not.toContain("v1.2.3");
  });

  test("embeds the hidden memory block when memory is present", () => {
    const body = renderTrackingBody({
      status: "success",
      memory: [{ instruction: "do x", summary: "did x" }],
    });
    expect(body).toContain("<!-- deep-agent:memory:");
  });

  test("omits the memory block when there is no memory", () => {
    expect(renderTrackingBody({ status: "working" })).not.toContain("deep-agent:memory");
  });
});

describe("parseTrackingStatus", () => {
  test("round-trips every RunStatus (+ working) through the hidden marker", () => {
    for (const status of [
      "working",
      "success",
      "skipped",
      "refused",
      "failed",
      "interrupted",
    ] as const) {
      expect(parseTrackingStatus(renderTrackingBody({ status }))).toBe(status);
    }
  });

  test("returns undefined when the marker is absent or unrecognized", () => {
    expect(parseTrackingStatus("just a regular comment")).toBeUndefined();
    expect(parseTrackingStatus("<!-- deep-agent:status:bogus -->")).toBeUndefined();
  });
});

describe("truncateTrackingBody", () => {
  const memory: MemoryTurn[] = [
    { instruction: "add a flag", summary: "added --verbose", prUrl: "https://x/pull/1" },
  ];

  test("returns bodies under the limit unchanged", () => {
    const body = renderTrackingBody({ status: "working", instruction: "fix bug", memory });
    expect(truncateTrackingBody(body)).toBe(body);
  });

  test("clamps an oversized body, keeping the marker and round-tripping the memory block", () => {
    const body = renderTrackingBody({
      status: "success",
      instruction: "big task",
      summary: "x".repeat(80_000),
      memory,
    });
    const out = truncateTrackingBody(body);
    expect(out.length).toBeLessThanOrEqual(65_536);
    expect(out.startsWith("<!-- deep-agent:tracking -->")).toBe(true);
    expect(out).toContain("truncated");
    expect(parseMemory(out)).toEqual(memory);
  });

  test("clamps an oversized body with no memory block", () => {
    const body = renderTrackingBody({ status: "success", summary: "y".repeat(80_000) });
    const out = truncateTrackingBody(body);
    expect(out.length).toBeLessThanOrEqual(65_536);
    expect(out.startsWith("<!-- deep-agent:tracking -->")).toBe(true);
  });

  test("drops a memory block that alone exceeds the limit (defensive)", () => {
    // renderMemoryBlock doesn't cap fields itself (appendTurn does), so a
    // hand-crafted oversized block must be dropped rather than kept over-limit.
    const body = renderTrackingBody({
      status: "success",
      memory: [{ instruction: "i", summary: "s".repeat(70_000) }],
    });
    const out = truncateTrackingBody(body);
    expect(out.length).toBeLessThanOrEqual(65_536);
    expect(parseMemory(out)).toEqual([]);
  });
});
