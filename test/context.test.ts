import { describe, expect, test } from "bun:test";
import { parseContext } from "../src/github/context.js";
import { makeRaw } from "./mockContext.js";

describe("parseContext", () => {
  test("normalizes an issue_comment event", () => {
    const ctx = parseContext(makeRaw());
    expect(ctx.owner).toBe("acme");
    expect(ctx.repo).toBe("widgets");
    expect(ctx.entityNumber).toBe(12);
    expect(ctx.isPR).toBe(false);
    expect(ctx.triggerText).toBe("@agent please fix");
    expect(ctx.commentId).toBe(555);
    expect(ctx.labels).toEqual(["bug"]);
  });

  test("detects a PR via issue.pull_request on an issue_comment", () => {
    const ctx = parseContext(
      makeRaw({
        payload: {
          action: "created",
          issue: { number: 9, pull_request: {}, labels: [] },
          comment: { id: 1, body: "@agent go" },
        },
      }),
    );
    expect(ctx.isPR).toBe(true);
    expect(ctx.entityNumber).toBe(9);
  });

  test("extracts head/base repo + refs for a pull_request event", () => {
    const ctx = parseContext(
      makeRaw({
        eventName: "pull_request",
        payload: {
          action: "opened",
          pull_request: {
            number: 7,
            title: "Add feature",
            body: "@agent review",
            head: { ref: "feature", repo: { full_name: "mallory/widgets" } },
            base: { ref: "main", repo: { full_name: "acme/widgets" } },
            labels: [],
          },
        },
      }),
    );
    expect(ctx.isPR).toBe(true);
    expect(ctx.prHeadRepoFullName).toBe("mallory/widgets");
    expect(ctx.prBaseRepoFullName).toBe("acme/widgets");
    expect(ctx.prHeadRef).toBe("feature");
    expect(ctx.triggerText).toContain("@agent review");
  });
});
