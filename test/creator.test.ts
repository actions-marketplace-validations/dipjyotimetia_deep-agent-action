import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const created: string[] = [];
const creator = join(
  import.meta.dir,
  "../packages/create-deep-agent-action/bin/create-deep-agent-action.mjs",
);

function makeRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "create-deep-agent-action-"));
  created.push(root);
  const init = Bun.spawnSync(["git", "init", "-q", root]);
  if (init.exitCode !== 0) throw new Error("Could not create test repository.");
  return root;
}

function runCreator(root: string, ...args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, creator, "--yes", "--directory", root, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("create-deep-agent-action", () => {
  test("ships an executable npx entrypoint", () => {
    expect(statSync(creator).mode & 0o111).not.toBe(0);
  });

  test("installs a pinned workflow and safe repository guidance", () => {
    const root = makeRepository();
    const result = runCreator(root);

    expect(result.exitCode).toBe(0);
    const workflow = readFileSync(join(root, ".github/workflows/deep-agent.yml"), "utf8");
    expect(workflow).toContain(
      "uses: dipjyotimetia/deep-agent-action@0aa91d295a53e472b0a8703d23c3cfc842164270",
    );
    expect(workflow).toContain('model: "claude-sonnet-5"');
    expect(workflow).toContain("require_push_approval: true");
    expect(workflow).toContain("PROVIDER_API_KEY: ${{ secrets.PROVIDER_API_KEY }}");
    expect(readFileSync(join(root, ".deepagents/AGENTS.md"), "utf8")).toContain(
      "Do not store credentials",
    );
  });

  test("preserves an existing workflow unless force is supplied", () => {
    const root = makeRepository();
    const workflowPath = join(root, ".github/workflows/deep-agent.yml");
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(workflowPath, "name: user workflow\n");

    const result = runCreator(root);

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(workflowPath)).toBe(true);
    expect(readFileSync(workflowPath, "utf8")).toBe("name: user workflow\n");
  });

  test("accepts non-interactive workflow settings without creating guidance", () => {
    const root = makeRepository();
    const result = runCreator(
      root,
      "--model",
      "openai:gpt-5",
      "--trigger-phrase",
      "@helper",
      "--workflow-file",
      "automation.yaml",
      "--no-guidance",
    );

    expect(result.exitCode).toBe(0);
    const workflow = readFileSync(join(root, ".github/workflows/automation.yaml"), "utf8");
    expect(workflow).toContain('model: "openai:gpt-5"');
    expect(workflow).toContain('trigger_phrase: "@helper"');
    expect(existsSync(join(root, ".deepagents/AGENTS.md"))).toBe(false);
  });

  test("replaces a generated workflow only with explicit force", () => {
    const root = makeRepository();
    const workflowPath = join(root, ".github/workflows/deep-agent.yml");
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, "name: user workflow\n");

    const result = runCreator(root, "--force");

    expect(result.exitCode).toBe(0);
    expect(readFileSync(workflowPath, "utf8")).toContain("name: Deep Agent");
  });
});
