import { describe, expect, test } from "bun:test";
import { fetchThread } from "../src/github/thread.js";
import { MARKER } from "../src/github/comments.js";
import { makeContext } from "./mockContext.js";

/** Fake Octokit: `paginate` just calls the given method and unwraps `.data`,
 * matching the real client closely enough for a single-page comment list. */
function fakeOctokit(opts: {
  entity: { title: string; body?: string | null };
  comments: { id: number; body?: string | null; user?: { login: string } | null }[];
}) {
  return {
    rest: {
      issues: {
        get: async () => ({ data: opts.entity }),
        listComments: async () => ({ data: opts.comments }),
      },
    },
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) =>
      (await fn(params)).data,
  };
}

describe("fetchThread", () => {
  test("returns nothing when the event has no entity number", async () => {
    const octokit = fakeOctokit({ entity: { title: "x" }, comments: [] });
    const ctx = makeContext({ entityNumber: undefined });
    expect(await fetchThread(octokit as any, ctx)).toEqual({});
  });

  test("renders the issue title/body and prior human comments", async () => {
    const octokit = fakeOctokit({
      entity: { title: "[BUG] env params not recognised", body: "template body" },
      comments: [
        { id: 1, body: "Could you clarify this request?", user: { login: "github-actions" } },
        {
          id: 2,
          body: "Actually the real bug is templated {{baseUrl}} not resolving in history.",
          user: { login: "alice" },
        },
        { id: 555, body: "@agent how to address this issue", user: { login: "alice" } },
      ],
    });
    const ctx = makeContext({ entityNumber: 442, commentId: 555 });

    const result = await fetchThread(octokit as any, ctx);

    expect(result.context).toContain("Issue #442");
    expect(result.context).toContain("[BUG] env params not recognised");
    expect(result.context).toContain("template body");
    expect(result.context).toContain("templated {{baseUrl}} not resolving");
    // The triggering comment itself is excluded — it's already the instruction.
    expect(result.context).not.toContain("how to address this issue");
  });

  test("finds and excludes the sticky tracking comment, surfacing it separately", async () => {
    const octokit = fakeOctokit({
      entity: { title: "Bug", body: "desc" },
      comments: [
        { id: 1, body: "some human comment", user: { login: "alice" } },
        { id: 2, body: `${MARKER}\nprior agent run`, user: { login: "github-actions" } },
      ],
    });
    const ctx = makeContext({ entityNumber: 1, commentId: 999 });

    const result = await fetchThread(octokit as any, ctx);

    expect(result.trackingComment).toEqual({ id: 2, body: `${MARKER}\nprior agent run` });
    expect(result.context).not.toContain("prior agent run");
    expect(result.context).toContain("some human comment");
  });

  test("labels a PR entity distinctly from an issue", async () => {
    const octokit = fakeOctokit({ entity: { title: "Add feature" }, comments: [] });
    const ctx = makeContext({ entityNumber: 7, isPR: true });
    const result = await fetchThread(octokit as any, ctx);
    expect(result.context).toContain("Pull request #7");
  });

  test("degrades to {} when the API call fails", async () => {
    const octokit = {
      rest: {
        issues: {
          get: async () => {
            throw new Error("boom");
          },
          listComments: async () => ({ data: [] }),
        },
      },
      paginate: async (fn: any, params: any) => (await fn(params)).data,
    };
    const ctx = makeContext({ entityNumber: 442 });
    expect(await fetchThread(octokit as any, ctx)).toEqual({});
  });

  test("caps prior comments to the most recent N in a long thread", async () => {
    const comments = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      body: `comment number ${i + 1}`,
      user: { login: "alice" },
    }));
    const octokit = fakeOctokit({ entity: { title: "Long thread" }, comments });
    const ctx = makeContext({ entityNumber: 1, commentId: undefined });

    const result = await fetchThread(octokit as any, ctx);

    expect(result.context).toContain("comment number 40");
    expect(result.context).toContain("comment number 26");
    expect(result.context).not.toContain("comment number 25");
  });

  test("truncates an oversized single comment body", async () => {
    const huge = "x".repeat(5000);
    const octokit = fakeOctokit({
      entity: { title: "Bug" },
      comments: [{ id: 1, body: huge, user: { login: "alice" } }],
    });
    const ctx = makeContext({ entityNumber: 1, commentId: undefined });

    const result = await fetchThread(octokit as any, ctx);

    expect(result.context!.length).toBeLessThan(huge.length);
    expect(result.context).toContain("…");
  });

  describe("realistic scenario: restura#442", () => {
    // Reproduces the actual reported bug: the issue template was left mostly
    // blank, the real bug report arrived as a follow-up human comment, and
    // only then did the user type "@agent how to address this issue" — a
    // separate, later comment. Before this fix, the agent only ever saw that
    // last fragment and had no way to know what "this issue" referred to.
    const entity = {
      title: "[BUG] There is an issue with the env params not being recognised",
      body: [
        "## Bug Description",
        "",
        "env params not being recognised",
        "",
        "## Steps to Reproduce",
        "",
        "1. Go to '...'",
      ].join("\n"),
    };
    const comments = [
      {
        id: 1001,
        body: "Could you clarify this request? I couldn't tell what change to make.",
        user: { login: "github-actions" },
      },
      {
        id: 1002,
        body:
          "Found (via live browser testing of environment management at localhost:5173) that a " +
          "request sent to a templated URL like {{baseUrl}}/anything resolves and sends correctly, " +
          "but both the History panel and the Console/Network log persist the raw, unresolved " +
          "{{baseUrl}}/anything string instead of the URL actually used.",
        user: { login: "dipjyotimetia" },
      },
      { id: 1003, body: "@agent how to address this issue", user: { login: "dipjyotimetia" } },
    ];

    test("surfaces the real bug description even though it's not in the triggering comment", async () => {
      const octokit = fakeOctokit({ entity, comments });
      const ctx = makeContext({ entityNumber: 442, commentId: 1003 });

      const result = await fetchThread(octokit as any, ctx);

      expect(result.context).toContain("env params not being recognised");
      expect(result.context).toContain("templated URL like {{baseUrl}}/anything");
      expect(result.context).toContain("History panel and the Console/Network log");
      // The triggering comment is excluded — it's already delivered as the instruction.
      expect(result.context).not.toContain("how to address this issue");
    });
  });
});
