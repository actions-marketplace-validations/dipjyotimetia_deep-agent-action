import { describe, expect, test } from "bun:test";
import {
  sanitizeBranchName,
  generateBranchName,
  buildRunBranchSuffix,
  explainGitHubError,
  isMissingRemoteBranchStatus,
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

describe("buildRunBranchSuffix", () => {
  test("uses the composite action invocation id to isolate matrix copies", () => {
    expect(
      buildRunBranchSuffix({
        DEEP_AGENT_INVOCATION_ID: "6b354af1-9d47-4aa1-b2d0-b60f6bc242f4",
        GITHUB_RUN_ID: "30462463978",
        GITHUB_JOB: "matrix-job",
        GITHUB_ACTION: "agent",
      }),
    ).toBe("6b354af1-9d47-4aa1-b2d0-b60f6bc242f4");
  });

  test("separates action invocations within the same workflow run", () => {
    expect(
      buildRunBranchSuffix({
        GITHUB_RUN_ID: "30462463978",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: "implement",
        GITHUB_ACTION: "agent",
      }),
    ).toBe("30462463978-1-implement-agent");
    expect(
      buildRunBranchSuffix({
        GITHUB_RUN_ID: "30462463978",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: "approval-gate",
        GITHUB_ACTION: "agent",
      }),
    ).toBe("30462463978-1-approval-gate-agent");
  });
});

describe("isMissingRemoteBranchStatus", () => {
  test("recognizes only git ls-remote's missing-ref exit status", () => {
    expect(isMissingRemoteBranchStatus(2)).toBe(true);
    expect(isMissingRemoteBranchStatus(1)).toBe(false);
    expect(isMissingRemoteBranchStatus(128)).toBe(false);
    expect(isMissingRemoteBranchStatus(undefined)).toBe(false);
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

  test("does not hide a PR lookup failure during landing", async () => {
    const octokit = {
      rest: {
        pulls: {
          list: async () => {
            throw new Error("GitHub API unavailable");
          },
        },
      },
    } as any;

    await expect(reuseExistingPr(octokit, ctx, "deep-agent/issue-12")).rejects.toThrow(
      "GitHub API unavailable",
    );
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
    expect(await reuseExistingPr(octokit, ctx, "deep-agent/issue-12")).toEqual({
      url: "https://github.com/x/1",
      isDraft: false,
    });
    expect(updated).toBe(false);
  });

  test("converts a reused ready PR to draft when approval is required", async () => {
    let convertedWith: unknown;
    const octokit = {
      rest: {
        pulls: {
          list: async () => ({
            data: [
              {
                number: 7,
                node_id: "PR_kwDOExample",
                state: "open",
                draft: false,
                merged_at: null,
                html_url: "https://github.com/x/7",
              },
            ],
          }),
        },
      },
      graphql: async (_query: string, variables: unknown) => {
        convertedWith = variables;
        return { convertPullRequestToDraft: { pullRequest: { isDraft: true } } };
      },
    } as any;

    expect(
      await reuseExistingPr(octokit, ctx, "deep-agent/issue-12", { requireDraft: true }),
    ).toEqual({
      url: "https://github.com/x/7",
      isDraft: true,
    });
    expect(convertedWith).toEqual({ pullRequestId: "PR_kwDOExample" });
  });

  test("reports an existing draft PR as still approval-pending", async () => {
    const octokit = {
      rest: {
        pulls: {
          list: async () => ({
            data: [
              {
                number: 7,
                state: "open",
                draft: true,
                merged_at: null,
                html_url: "https://github.com/x/7",
              },
            ],
          }),
        },
      },
      graphql: async () => {
        throw new Error("draft PR must not be converted again");
      },
    } as any;

    expect(await reuseExistingPr(octokit, ctx, "deep-agent/issue-12")).toEqual({
      url: "https://github.com/x/7",
      isDraft: true,
    });
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
    expect(await reuseExistingPr(octokit, ctx, "deep-agent/issue-12")).toEqual({
      url: "https://github.com/x/7",
      isDraft: false,
    });
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
