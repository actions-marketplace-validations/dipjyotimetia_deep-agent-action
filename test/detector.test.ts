import { describe, expect, test } from "bun:test";
import {
  detectMode,
  isReviewRequest,
  isReviewAndFixRequest,
  isResumeRequest,
} from "../src/modes/detector.js";
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

  test("labeled issue with the matching auto_run_label runs the agent without the phrase", () => {
    const ctx = makeContext({
      eventName: "issues",
      eventAction: "labeled",
      eventLabel: "agent-auto",
      triggerText: "just a bug report, no mention",
    });
    expect(detectMode(ctx, { triggerPhrase: phrase, autoRunLabel: "agent-auto" })).toBe("agent");
  });

  test("labeled issue with a non-matching label is still gated by the phrase", () => {
    const ctx = makeContext({
      eventName: "issues",
      eventAction: "labeled",
      eventLabel: "bug",
      triggerText: "just a bug report, no mention",
    });
    expect(detectMode(ctx, { triggerPhrase: phrase, autoRunLabel: "agent-auto" })).toBe("noop");
  });

  test("assigned issue with the matching auto_run_assignee runs the agent without the phrase", () => {
    const ctx = makeContext({
      eventName: "issues",
      eventAction: "assigned",
      eventAssignee: "deep-agent-bot",
      triggerText: "no mention here",
    });
    expect(detectMode(ctx, { triggerPhrase: phrase, autoRunAssignee: "deep-agent-bot" })).toBe(
      "agent",
    );
  });

  test("assigned issue to a different user is still gated by the phrase", () => {
    const ctx = makeContext({
      eventName: "issues",
      eventAction: "assigned",
      eventAssignee: "someone-else",
      triggerText: "no mention here",
    });
    expect(detectMode(ctx, { triggerPhrase: phrase, autoRunAssignee: "deep-agent-bot" })).toBe(
      "noop",
    );
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

describe("isReviewAndFixRequest", () => {
  test("matches 'review and fix' / 'review & fix'", () => {
    expect(isReviewAndFixRequest("review and fix this PR")).toBe(true);
    expect(isReviewAndFixRequest("Review & fix please")).toBe(true);
  });
  test("does not match a plain review or unrelated instruction", () => {
    expect(isReviewAndFixRequest("review this PR")).toBe(false);
    expect(isReviewAndFixRequest("fix the bug")).toBe(false);
  });
  test("a review-and-fix instruction also matches isReviewRequest", () => {
    expect(isReviewRequest("review and fix this PR")).toBe(true);
  });
});

describe("isResumeRequest", () => {
  test("matches 'continue'/'resume' at the start", () => {
    expect(isResumeRequest("continue")).toBe(true);
    expect(isResumeRequest("Resume the plan")).toBe(true);
    expect(isResumeRequest("  continue please")).toBe(true);
  });
  test("does not match unrelated instructions", () => {
    expect(isResumeRequest("fix the bug")).toBe(false);
    expect(isResumeRequest("please continue with this")).toBe(false);
  });
});
