import { describe, expect, test } from "bun:test";
import { sanitizeBranchName, generateBranchName, explainGitHubError } from "../src/github/ops.js";
import { makeContext } from "./mockContext.js";

describe("sanitizeBranchName", () => {
  test("replaces unsafe characters", () => {
    expect(sanitizeBranchName("feat/Fix Bug! (#12)")).toBe("feat/Fix-Bug-12");
  });
  test("strips leading/trailing separators", () => {
    expect(sanitizeBranchName("--/foo/--")).toBe("foo");
  });
  test("caps length", () => {
    expect(sanitizeBranchName("a".repeat(300)).length).toBe(240);
  });
});

describe("generateBranchName", () => {
  test("issue branch", () => {
    const ctx = makeContext({ isPR: false, entityNumber: 12 });
    expect(generateBranchName(ctx, "987")).toBe("deep-agent/issue-12-987");
  });
  test("dispatch branch when no entity", () => {
    const ctx = makeContext({ isPR: false, entityNumber: undefined });
    expect(generateBranchName(ctx, "5")).toBe("deep-agent/dispatch-5");
  });
});

describe("explainGitHubError", () => {
  test("adds an actionable hint for the create-PR permission error", () => {
    const out = explainGitHubError(
      "GitHub Actions is not permitted to create or approve pull requests.",
    );
    expect(out).toContain("Allow GitHub Actions to create and approve pull requests");
    expect(out).toContain("app_id");
  });

  test("passes unrelated messages through unchanged", () => {
    expect(explainGitHubError("Validation failed: head sha can't be blank")).toBe(
      "Validation failed: head sha can't be blank",
    );
  });

  test("adds a hint for protected-branch rejections", () => {
    const out = explainGitHubError(
      "git push failed: remote: error: GH006: Protected branch update failed for refs/heads/main.",
    );
    expect(out).toContain("protection rules");
    expect(out).toContain("require_push_approval");
  });

  test("adds a hint for non-fast-forward pushes", () => {
    const out = explainGitHubError("git push failed: ! [rejected] main -> main (non-fast-forward)");
    expect(out).toContain("branch moved");
    expect(out).toContain("concurrency");
  });
});
