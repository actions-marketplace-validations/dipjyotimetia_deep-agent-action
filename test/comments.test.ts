import { describe, expect, test } from "bun:test";
import { renderTrackingBody } from "../src/github/comments.js";

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
});
