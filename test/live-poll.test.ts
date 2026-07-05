import { describe, expect, test } from "bun:test";
import { classifyTrackingBody } from "../scripts/e2e/live/poll.js";
import { renderTrackingBody } from "../src/github/comments.js";

describe("classifyTrackingBody", () => {
  test("classifies every real status the tracking comment can render", () => {
    expect(classifyTrackingBody(renderTrackingBody({ status: "working" }))).toBe("working");
    expect(classifyTrackingBody(renderTrackingBody({ status: "success" }))).toBe("success");
    expect(classifyTrackingBody(renderTrackingBody({ status: "skipped" }))).toBe("skipped");
    expect(classifyTrackingBody(renderTrackingBody({ status: "refused" }))).toBe("refused");
    expect(classifyTrackingBody(renderTrackingBody({ status: "failed" }))).toBe("failed");
  });

  test("returns undefined for a body with no tracking marker", () => {
    expect(classifyTrackingBody("just a regular comment, not from the agent")).toBeUndefined();
    expect(classifyTrackingBody("✅ Done. (no marker though)")).toBeUndefined();
  });

  test("returns undefined for a marked body with no recognizable status text", () => {
    expect(
      classifyTrackingBody("<!-- deep-agent:tracking -->\nsomething unexpected"),
    ).toBeUndefined();
  });
});
