import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("published documentation contracts", () => {
  test("documents the npx creator and the ephemeral-runner boundary", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const featureReview = readFileSync(join(root, "docs/feature-review.md"), "utf8");

    expect(readme).toContain("npx create-deep-agent-action");
    expect(featureReview).toContain("Async remote subagents");
    expect(featureReview).toContain("Persistent checkpointers and stores");
  });

  test("does not advertise unsupported tool-interrupt configuration", () => {
    for (const file of ["README.md", "docs/configuration.md", "docs/security.md"]) {
      const content = readFileSync(join(root, file), "utf8");
      expect(content).not.toContain("| `interrupt_on`");
      expect(content).not.toContain("All MCP tools are **interrupted by default**");
    }
  });

  test("keeps the OpenWiki snapshot aligned with the ephemeral runtime", () => {
    for (const file of [
      "openwiki/architecture/agent.md",
      "openwiki/architecture/overview.md",
      "openwiki/guides/configuration.md",
      "openwiki/guides/security.md",
    ]) {
      const content = readFileSync(join(root, file), "utf8");
      expect(content).not.toContain("interrupt_on");
      expect(content).not.toContain("MemorySaver checkpointer");
      expect(content).not.toContain("MCP tools are **interrupted by default**");
    }
  });
});
