import { describe, expect, test } from "bun:test";
import {
  sanitizeBranchName,
  generateBranchName,
  explainGitHubError,
  buildPrBody,
  reuseExistingPr,
} from "../src/github/ops.js";
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
  test("issue branch is stable per issue (no run-suffix)", () => {
    const ctx = makeContext({ isPR: false, entityNumber: 12 });
    expect(generateBranchName(ctx, "987")).toBe("deep-agent/issue-12");
  });
  test("issue branch name doesn't change across separate runs (continuity)", () => {
    const ctx = makeContext({ isPR: false, entityNumber: 12 });
    expect(generateBranchName(ctx, "111")).toBe(generateBranchName(ctx, "222"));
  });
  test("dispatch branch when no entity falls back to the run-scoped suffix", () => {
    const ctx = makeContext({ isPR: false, entityNumber: undefined });
    expect(generateBranchName(ctx, "5")).toBe("deep-agent/dispatch-5");
  });
});

describe("buildPrBody", () => {
  test("references the issue number when present", () => {
    const ctx = makeContext({ entityNumber: 12 });
    expect(buildPrBody(ctx, "fix the typo")).toContain("#12");
    expect(buildPrBody(ctx, "fix the typo")).toContain("fix the typo");
  });

  test("omits the issue reference for a bare dispatch", () => {
    const ctx = makeContext({ entityNumber: undefined });
    expect(buildPrBody(ctx, "do the thing")).not.toContain("#undefined");
  });
});

describe("reuseExistingPr", () => {
  const ctx = makeContext({ owner: "acme", repo: "widgets", entityNumber: 12 });

  test("returns undefined when no PR exists for the branch", async () => {
    const octokit = { rest: { pulls: { list: async () => ({ data: [] }) } } } as any;
    expect(await reuseExistingPr(octokit, ctx, "deep-agent/issue-12")).toBeUndefined();
  });

  test("reuses an open PR without reopening it", async () => {
    let updated = false;
    const octokit = {
      rest: {
        pulls: {
          list: async () => ({
            data: [{ state: "open", merged_at: null, html_url: "https://github.com/x/1" }],
          }),
          update: async () => {
            updated = true;
          },
        },
      },
    } as any;
    expect(await reuseExistingPr(octokit, ctx, "deep-agent/issue-12")).toBe(
      "https://github.com/x/1",
    );
    expect(updated).toBe(false);
  });

  test("reopens a closed (non-merged) PR and reuses it", async () => {
    let reopenedWith: unknown;
    const octokit = {
      rest: {
        pulls: {
          list: async () => ({
            data: [
              { number: 7, state: "closed", merged_at: null, html_url: "https://github.com/x/7" },
            ],
          }),
          update: async (args: unknown) => {
            reopenedWith = args;
          },
        },
      },
    } as any;
    expect(await reuseExistingPr(octokit, ctx, "deep-agent/issue-12")).toBe(
      "https://github.com/x/7",
    );
    expect(reopenedWith).toEqual({
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      state: "open",
    });
  });

  test("ignores a merged PR (lets the caller open a new one)", async () => {
    const octokit = {
      rest: {
        pulls: {
          list: async () => ({
            data: [
              { state: "closed", merged_at: "2024-01-01", html_url: "https://github.com/x/3" },
            ],
          }),
        },
      },
    } as any;
    expect(await reuseExistingPr(octokit, ctx, "deep-agent/issue-12")).toBeUndefined();
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
