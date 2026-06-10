import { describe, expect, test } from "bun:test";
import { buildReviewEvent } from "../scripts/e2e/build-review-event.js";
import { parseContext } from "../src/github/context.js";

describe("buildReviewEvent", () => {
  test("produces an issue_comment payload shaped like a PR review request", () => {
    const ev = buildReviewEvent({ prNumber: 42, commentBody: "@agent review", commentId: 99 });
    expect(ev.action).toBe("created");
    expect(ev.issue.number).toBe(42);
    expect(ev.issue.pull_request).toBeDefined();
    expect(ev.comment.id).toBe(99);
    expect(ev.comment.body).toBe("@agent review");
  });

  test("parseContext resolves it to a PR carrying the review instruction", () => {
    const ev = buildReviewEvent({ prNumber: 7, commentBody: "@agent review please", commentId: 1 });
    const ctx = parseContext({
      eventName: "issue_comment",
      actor: "alice",
      repo: { owner: "acme", repo: "widgets" },
      payload: ev as unknown as Record<string, unknown>,
    });
    expect(ctx.isPR).toBe(true);
    expect(ctx.entityNumber).toBe(7);
    expect(ctx.triggerText).toBe("@agent review please");
    expect(ctx.commentId).toBe(1);
  });

  test("defaults the body to the review trigger and coerces string numbers", () => {
    const ev = buildReviewEvent({ prNumber: "12" });
    expect(ev.issue.number).toBe(12);
    expect(ev.comment.body).toContain("review");
  });

  test("throws when prNumber is missing", () => {
    expect(() => buildReviewEvent({ prNumber: "" })).toThrow(/prNumber is required/);
  });
});
