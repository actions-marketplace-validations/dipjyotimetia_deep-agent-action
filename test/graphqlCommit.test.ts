import { describe, expect, test } from "bun:test";
import {
  parsePorcelainStatus,
  ensureRefExists,
  createCommitOnBranchMutation,
} from "../src/github/graphqlCommit.js";

describe("parsePorcelainStatus", () => {
  test("empty output yields no changes", () => {
    expect(parsePorcelainStatus("")).toEqual({ additionPaths: [], deletionPaths: [] });
  });

  test("classifies modified, added, and untracked files as additions", () => {
    const out = [" M src/foo.ts", "A  src/bar.ts", "?? src/baz.ts"].join("\n");
    expect(parsePorcelainStatus(out)).toEqual({
      additionPaths: ["src/foo.ts", "src/bar.ts", "src/baz.ts"],
      deletionPaths: [],
    });
  });

  test("classifies deleted files as deletions", () => {
    const out = " D src/old.ts";
    expect(parsePorcelainStatus(out)).toEqual({
      additionPaths: [],
      deletionPaths: ["src/old.ts"],
    });
  });

  test("classifies a rename as a deletion of the old path plus an addition of the new path", () => {
    const out = "R  src/old.ts -> src/new.ts";
    expect(parsePorcelainStatus(out)).toEqual({
      additionPaths: ["src/new.ts"],
      deletionPaths: ["src/old.ts"],
    });
  });

  test("ignores blank lines", () => {
    const out = " M src/foo.ts\n\n";
    expect(parsePorcelainStatus(out)).toEqual({
      additionPaths: ["src/foo.ts"],
      deletionPaths: [],
    });
  });
});

describe("ensureRefExists", () => {
  const params = {
    owner: "acme",
    repo: "widgets",
    branch: "deep-agent/issue-12",
    fromSha: "abc123",
  };

  test("no-ops when the ref already exists", async () => {
    let created = false;
    const octokit = {
      rest: {
        git: {
          getRef: async () => ({ data: {} }),
          createRef: async () => {
            created = true;
          },
        },
      },
    } as any;
    await ensureRefExists(octokit, params);
    expect(created).toBe(false);
  });

  test("creates the ref when it's missing (404)", async () => {
    let createdWith: unknown;
    const octokit = {
      rest: {
        git: {
          getRef: async () => {
            throw { status: 404 };
          },
          createRef: async (args: unknown) => {
            createdWith = args;
          },
        },
      },
    } as any;
    await ensureRefExists(octokit, params);
    expect(createdWith).toEqual({
      owner: "acme",
      repo: "widgets",
      ref: "refs/heads/deep-agent/issue-12",
      sha: "abc123",
    });
  });

  test("rethrows non-404 errors from the existence check", async () => {
    const octokit = {
      rest: { git: { getRef: async () => Promise.reject({ status: 500 }) } },
    } as any;
    await expect(ensureRefExists(octokit, params)).rejects.toBeDefined();
  });
});

describe("createCommitOnBranchMutation", () => {
  test("returns the commit from a successful mutation", async () => {
    const octokit = {
      graphql: async () => ({
        createCommitOnBranch: { commit: { oid: "deadbeef", url: "https://github.com/x" } },
      }),
    } as any;
    const result = await createCommitOnBranchMutation(octokit, {
      owner: "acme",
      repo: "widgets",
      branch: "deep-agent/issue-12",
      expectedHeadOid: "abc123",
      message: "Deep Agent: fix the bug",
      additions: [],
      deletions: [],
    });
    expect(result).toEqual({ oid: "deadbeef", url: "https://github.com/x" });
  });

  test("wraps a stale expectedHeadOid failure with an actionable hint", async () => {
    const octokit = {
      graphql: async () => {
        throw new Error("failed to push some refs: expected head oid mismatch");
      },
    } as any;
    await expect(
      createCommitOnBranchMutation(octokit, {
        owner: "acme",
        repo: "widgets",
        branch: "deep-agent/issue-12",
        expectedHeadOid: "abc123",
        message: "Deep Agent: fix the bug",
        additions: [],
        deletions: [],
      }),
    ).rejects.toThrow(/branch moved/);
  });
});
