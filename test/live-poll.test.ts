import { describe, expect, test } from "bun:test";
import { expectSuccess, extractPrUrl, type PolledComment } from "../scripts/e2e/live/poll.js";

function polled(state: PolledComment["state"], body = ""): PolledComment {
  return { state, body, updatedAt: "2026-01-01T00:00:00Z" };
}

describe("expectSuccess", () => {
  test("does not throw when the state is success", () => {
    expect(() => expectSuccess(polled("success"), "turn 1")).not.toThrow();
  });

  test("throws a labeled error with the body for any other state", () => {
    expect(() => expectSuccess(polled("failed", "boom"), "turn 1")).toThrow(
      /expected turn 1 state=success, got failed\nboom/,
    );
  });
});

describe("extractPrUrl", () => {
  test("extracts a plain pull-request link", () => {
    expect(extractPrUrl("**Pull request:** https://github.com/o/r/pull/1")).toBe(
      "https://github.com/o/r/pull/1",
    );
  });

  test("extracts a draft (awaiting approval) pull-request link", () => {
    expect(
      extractPrUrl("**Draft pull request (awaiting approval):** https://github.com/o/r/pull/2"),
    ).toBe("https://github.com/o/r/pull/2");
  });

  test("throws when no PR link is present", () => {
    expect(() => extractPrUrl("no link here")).toThrow(/no PR link found/);
  });
});
