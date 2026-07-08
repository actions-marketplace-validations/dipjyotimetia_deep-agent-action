import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { LocalShellBackend } from "deepagents";
import { buildShellEnv } from "../src/agent/env.js";

/**
 * Regression guard for the workspace sandboxing that `buildAgent` relies on.
 *
 * `buildAgent` constructs `LocalShellBackend` with `virtualMode: true` so the
 * built-in filesystem tools (ls/glob/grep/read/edit) cannot escape the repo
 * checkout. The motivating bug: in the default (virtualMode=false) mode an
 * exploratory model globbed outside the workspace, fast-glob recursed into an
 * unreadable `/home/packer` on the GitHub runner image, and — because
 * deepagents does not catch fast-glob errors — the EACCES rejection crashed the
 * entire run. This test pins the option values that prevent that.
 */
describe("buildAgent filesystem sandbox (virtualMode)", () => {
  // Mirrors the LocalShellBackend options used in createAgent.ts:buildAgent.
  function makeBackend(rootDir: string) {
    return new LocalShellBackend({
      rootDir,
      virtualMode: true,
      env: buildShellEnv(),
      timeout: 5,
      maxOutputBytes: 200_000,
    });
  }

  let root: string;
  let backend: LocalShellBackend;

  // Create a fresh tree per test.
  function setup(): void {
    root = mkdtempSync(join(tmpdir(), "da-sandbox-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const x = 1;\n");
    backend = makeBackend(root);
  }

  test("ls of an outside-root absolute path returns nothing (no escape, no throw)", async () => {
    setup();
    // "/etc" is real and outside the workspace root; in virtual mode it must
    // resolve under rootDir (where it does not exist) → empty, not the real /etc.
    const result = await backend.ls("/etc");
    expect(result.files ?? []).toEqual([]);
  });

  test("glob rooted outside the workspace returns nothing instead of throwing", async () => {
    setup();
    // A recursive glob at "/" must be contained to rootDir, never reaching the
    // real filesystem root (where unreadable dirs would crash fast-glob).
    const result = await backend.glob("**/*", "/");
    const paths = (result.files ?? []).map((f) => f.path);
    // Everything returned is inside the virtual workspace tree.
    for (const p of paths) expect(p.startsWith("..")).toBe(false);
    expect(paths.some((p) => p.includes("a.ts"))).toBe(true);
  });

  test("repo files remain readable via virtual absolute paths", async () => {
    setup();
    const result = await backend.read("/src/a.ts");
    // deepagents returns { content, ... } on success.
    const content = (result as { content?: string }).content ?? "";
    expect(content).toContain("export const x = 1");
  });
});
