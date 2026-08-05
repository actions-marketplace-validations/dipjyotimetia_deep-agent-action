import { describe, expect, test } from "bun:test";
import {
  currentTriageState,
  DEFAULT_TRIAGE_LABELS,
  routeTriage,
  resolveTriageInstruction,
  stateLabelSwap,
} from "../src/modes/triage.js";

describe("currentTriageState", () => {
  test("recognizes the configured lifecycle label while preserving unrelated labels", () => {
    expect(currentTriageState(["bug", DEFAULT_TRIAGE_LABELS.needsReproduction])).toBe(
      "needs_reproduction",
    );
  });

  test("returns null when no lifecycle label is present", () => {
    expect(currentTriageState(["bug", "priority: high"])).toBeNull();
  });
});

test("triage handoff requires reproduce, diagnose, verify, and validate before a fix", () => {
  const instruction = resolveTriageInstruction({
    eventName: "issues",
    owner: "owner",
    repo: "repo",
    actor: "alice",
    isPR: false,
    isPullRequestReviewComment: false,
    labels: [],
    triggerText: "It crashes after login.",
    payload: {},
  });
  expect(instruction).toContain("reproduce the report");
  expect(instruction).toContain("It crashes after login.");
});

describe("stateLabelSwap", () => {
  test("replaces only the current lifecycle label", () => {
    expect(
      stateLabelSwap(
        ["bug", DEFAULT_TRIAGE_LABELS.needsReproduction, "priority: high"],
        "needs_reproduction",
        "needs_maintainer",
      ),
    ).toEqual({
      remove: DEFAULT_TRIAGE_LABELS.needsReproduction,
      add: DEFAULT_TRIAGE_LABELS.needsMaintainer,
    });
  });

  test("adds the new lifecycle label when the issue has no previous state", () => {
    expect(stateLabelSwap(["bug"], null, "not_actionable")).toEqual({
      remove: undefined,
      add: DEFAULT_TRIAGE_LABELS.notActionable,
    });
  });
});

describe("routeTriage", () => {
  test("classifies newly opened issues", () => {
    expect(
      routeTriage({
        eventName: "issues",
        eventAction: "opened",
        isPR: false,
        labels: [],
        actor: "alice",
      }),
    ).toEqual({ type: "classify" });
  });

  test("ignores pull requests and bot comments", () => {
    expect(
      routeTriage({
        eventName: "issues",
        eventAction: "opened",
        isPR: true,
        labels: [],
        actor: "alice",
      }),
    ).toEqual({ type: "skip", reason: "pull_request" });
    expect(
      routeTriage({
        eventName: "issue_comment",
        eventAction: "created",
        isPR: false,
        labels: [DEFAULT_TRIAGE_LABELS.needsReproduction],
        actor: "github-actions[bot]",
      }),
    ).toEqual({ type: "skip", reason: "bot" });
  });

  test("retriages only states where a comment can provide new evidence", () => {
    expect(
      routeTriage({
        eventName: "issue_comment",
        eventAction: "created",
        isPR: false,
        labels: [DEFAULT_TRIAGE_LABELS.unableToFix],
        actor: "alice",
      }),
    ).toEqual({ type: "retriage", state: "unable_to_fix" });
    expect(
      routeTriage({
        eventName: "issue_comment",
        eventAction: "created",
        isPR: false,
        labels: [DEFAULT_TRIAGE_LABELS.fixProposed],
        actor: "alice",
      }),
    ).toEqual({ type: "skip", reason: "terminal_state" });
  });

  test("starts agentic triage only from the explicit maintainer-run label event", () => {
    expect(
      routeTriage({
        eventName: "issues",
        eventAction: "labeled",
        eventLabel: DEFAULT_TRIAGE_LABELS.run,
        isPR: false,
        labels: [DEFAULT_TRIAGE_LABELS.needsMaintainer, DEFAULT_TRIAGE_LABELS.run],
        actor: "maintainer",
      }),
    ).toEqual({ type: "run", state: "needs_maintainer" });
  });
});
