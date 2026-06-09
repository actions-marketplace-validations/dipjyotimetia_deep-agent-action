import { describe, expect, test } from "bun:test";
import { detectMode, isReviewRequest } from "../src/modes/detector.js";
import { makeContext } from "./mockContext.js";

const phrase = "@agent";

describe("detectMode", () => {
  test("workflow_dispatch with a prompt always runs the agent", () => {
    const ctx = makeContext({ eventName: "workflow_dispatch", triggerText: undefined });
    expect(detectMode(ctx, { triggerPhrase: phrase, prompt: "do the thing" })).toBe("agent");
  });

  test("issue_comment with the phrase runs the agent", () => {
    const ctx = makeContext({ eventName: "issue_comment", triggerText: "@agent fix" });
    expect(detectMode(ctx, { triggerPhrase: phrase })).toBe("agent");
  });

  test("issue_comment without the phrase is a no-op", () => {
    const ctx = makeContext({ eventName: "issue_comment", triggerText: "just chatting" });
    expect(detectMode(ctx, { triggerPhrase: phrase })).toBe("noop");
  });

  test("bare pull_request without a mention is a no-op (review is P1)", () => {
    const ctx = makeContext({
      eventName: "pull_request",
      eventAction: "opened",
      triggerText: "no mention here",
      isPR: true,
    });
    expect(detectMode(ctx, { triggerPhrase: phrase })).toBe("noop");
  });

  test("issues opened with the phrase runs the agent", () => {
    const ctx = makeContext({
      eventName: "issues",
      eventAction: "opened",
      triggerText: "@agent help",
    });
    expect(detectMode(ctx, { triggerPhrase: phrase })).toBe("agent");
  });

  test("unrelated events are a no-op", () => {
    const ctx = makeContext({ eventName: "push", triggerText: "@agent" });
    expect(detectMode(ctx, { triggerPhrase: phrase })).toBe("noop");
  });
});

describe("isReviewRequest", () => {
  test("matches instructions that start with review", () => {
    expect(isReviewRequest("review this PR")).toBe(true);
    expect(isReviewRequest("  Review the changes")).toBe(true);
  });
  test("does not match other instructions", () => {
    expect(isReviewRequest("fix the bug")).toBe(false);
    expect(isReviewRequest("add a review feature")).toBe(false);
  });
});
