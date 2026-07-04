import { describe, expect, test } from "bun:test";
import {
  classifyIssue,
  filterAllowedLabels,
  resolveTriageInstruction,
  type TriageDecision,
} from "../src/modes/triage.js";
import { makeContext } from "./mockContext.js";

describe("filterAllowedLabels", () => {
  test("keeps only labels within the configured allow-list", () => {
    const decision: TriageDecision = {
      action: "label",
      labels: ["bug", "duplicate", "made-up"],
      reason: "x",
    };
    expect(filterAllowedLabels(decision, ["bug", "duplicate"])).toEqual(["bug", "duplicate"]);
  });

  test("returns an empty array when the decision proposed no labels", () => {
    const decision: TriageDecision = { action: "label", reason: "x" };
    expect(filterAllowedLabels(decision, ["bug"])).toEqual([]);
  });

  test("returns an empty array when nothing is allowed", () => {
    const decision: TriageDecision = { action: "label", labels: ["bug"], reason: "x" };
    expect(filterAllowedLabels(decision, [])).toEqual([]);
  });
});

describe("resolveTriageInstruction", () => {
  test("uses the issue's title/body text when present", () => {
    const ctx = makeContext({ triggerText: "Fix the login bug" });
    expect(resolveTriageInstruction(ctx)).toBe("Fix the login bug");
  });

  test("falls back to a default instruction when there's no usable text", () => {
    const ctx = makeContext({ triggerText: undefined });
    expect(resolveTriageInstruction(ctx)).toBe("Triage and address this issue as appropriate.");
    const blank = makeContext({ triggerText: "   " });
    expect(resolveTriageInstruction(blank)).toBe("Triage and address this issue as appropriate.");
  });
});

describe("classifyIssue", () => {
  test("invokes the model's structured output and returns the decision", async () => {
    let capturedMessages: unknown;
    const fakeModel = {
      withStructuredOutput: (_schema: unknown) => ({
        invoke: async (messages: unknown) => {
          capturedMessages = messages;
          return { action: "open_pr", reason: "clear bug report" };
        },
      }),
    } as any;

    const ctx = makeContext({ triggerText: "Fix the crash on startup" });
    const decision = await classifyIssue(fakeModel, ctx, { allowedLabels: ["bug"] });

    expect(decision).toEqual({ action: "open_pr", reason: "clear bug report" });
    expect(Array.isArray(capturedMessages)).toBe(true);
    expect((capturedMessages as any[]).some((m) => m.role === "system")).toBe(true);
    expect((capturedMessages as any[]).some((m) => m.role === "user")).toBe(true);
  });
});
