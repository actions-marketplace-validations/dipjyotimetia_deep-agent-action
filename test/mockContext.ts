import type { GitHubContext } from "../src/types.js";
import type { RawContext } from "../src/github/context.js";

/** Base normalized context; spread + override per test. */
export const baseContext: GitHubContext = {
  eventName: "issue_comment",
  eventAction: "created",
  owner: "acme",
  repo: "widgets",
  actor: "alice",
  entityNumber: 12,
  isPR: false,
  triggerText: "@agent fix the typo in the README",
  commentId: 555,
  isPullRequestReviewComment: false,
  labels: [],
  payload: {},
};

export function makeContext(overrides: Partial<GitHubContext> = {}): GitHubContext {
  return { ...baseContext, ...overrides };
}

/** Base raw @actions/github context for parseContext tests. */
export const baseRaw: RawContext = {
  eventName: "issue_comment",
  actor: "alice",
  repo: { owner: "acme", repo: "widgets" },
  payload: {
    action: "created",
    issue: { number: 12, labels: [{ name: "bug" }] },
    comment: { id: 555, body: "@agent please fix" },
  },
};

export function makeRaw(overrides: Partial<RawContext> = {}): RawContext {
  return { ...baseRaw, ...overrides };
}

/** Minimal Octokit stub: provide just the methods a test exercises. */
export function mockOctokit(impl: Record<string, any>): any {
  return { rest: impl };
}
