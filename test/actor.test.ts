import { describe, expect, test } from "bun:test";
import { looksLikeBotLogin, checkActorIsHuman } from "../src/github/validation/actor.js";
import { mockOctokit } from "./mockContext.js";

describe("looksLikeBotLogin", () => {
  test("flags [bot] logins", () => {
    expect(looksLikeBotLogin("dependabot[bot]")).toBe(true);
    expect(looksLikeBotLogin("github-actions[bot]")).toBe(true);
  });
  test("does not flag normal users", () => {
    expect(looksLikeBotLogin("alice")).toBe(false);
  });
});

describe("checkActorIsHuman", () => {
  test("rejects [bot] logins without an API call", async () => {
    const octokit = mockOctokit({
      users: { getByUsername: async () => ({ data: { type: "User" } }) },
    });
    expect((await checkActorIsHuman(octokit, "some[bot]")).ok).toBe(false);
  });

  test("accepts a real User account", async () => {
    const octokit = mockOctokit({
      users: { getByUsername: async () => ({ data: { type: "User" } }) },
    });
    expect((await checkActorIsHuman(octokit, "alice")).ok).toBe(true);
  });

  test("rejects non-User account types", async () => {
    const octokit = mockOctokit({
      users: { getByUsername: async () => ({ data: { type: "Bot" } }) },
    });
    expect((await checkActorIsHuman(octokit, "weirdbot")).ok).toBe(false);
  });

  test("rejects unresolvable accounts", async () => {
    const octokit = mockOctokit({
      users: {
        getByUsername: async () => {
          throw new Error("404");
        },
      },
    });
    expect((await checkActorIsHuman(octokit, "ghost")).ok).toBe(false);
  });
});
