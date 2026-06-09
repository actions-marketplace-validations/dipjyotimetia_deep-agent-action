import { describe, expect, test } from "bun:test";
import { isPermitted, checkActorPermission } from "../src/github/validation/permissions.js";
import { mockOctokit } from "./mockContext.js";

describe("isPermitted", () => {
  const allowed = ["write", "admin"];
  test("permits write/admin", () => {
    expect(isPermitted("write", allowed)).toBe(true);
    expect(isPermitted("admin", allowed)).toBe(true);
  });
  test("maintain satisfies a write requirement", () => {
    expect(isPermitted("maintain", allowed)).toBe(true);
  });
  test("rejects read/triage/none/undefined", () => {
    expect(isPermitted("read", allowed)).toBe(false);
    expect(isPermitted("triage", allowed)).toBe(false);
    expect(isPermitted("none", allowed)).toBe(false);
    expect(isPermitted(undefined, allowed)).toBe(false);
  });
});

describe("checkActorPermission", () => {
  const params = { owner: "acme", repo: "widgets", username: "alice", allowed: ["write", "admin"] };

  test("ok for a write collaborator", async () => {
    const octokit = mockOctokit({
      repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }) },
    });
    expect((await checkActorPermission(octokit, params)).ok).toBe(true);
  });

  test("refuses a read collaborator with a reason", async () => {
    const octokit = mockOctokit({
      repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: "read" } }) },
    });
    const res = await checkActorPermission(octokit, params);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("read");
  });

  test("refuses when the API call fails", async () => {
    const octokit = mockOctokit({
      repos: {
        getCollaboratorPermissionLevel: async () => {
          throw new Error("404");
        },
      },
    });
    expect((await checkActorPermission(octokit, params)).ok).toBe(false);
  });
});
