import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "..");

describe("OpenWiki automation", () => {
  test("refreshes OpenWiki weekly through a reviewed App-authored pull request", () => {
    const workflow = readFileSync(join(root, ".github/workflows/openwiki-update.yml"), "utf8");
    expect(workflow).toContain('cron: "0 8 * * 1"');
    expect(workflow).toContain("openwiki@0.4.3");
    expect(workflow).toContain('OPENWIKI_TELEMETRY_DISABLED: "1"');
    expect(workflow).toContain("OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}");
    expect(workflow).toContain("permission-pull-requests: write");
    expect(workflow).toContain("branch: openwiki/update");
    expect(workflow).toContain("base: main");
    expect(workflow).not.toMatch(/uses: [^\s]+@v\d/u);
  });

  test("publishes merged docs with an immutable reusable-action reference", () => {
    const workflow = readFileSync(join(root, ".github/workflows/publish-github-wiki.yml"), "utf8");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain('- "openwiki/**"');
    expect(workflow).toContain("permission-contents: write");
    expect(workflow).toMatch(/uses: dipjyotimetia\/openwiki-github-wiki-action@[0-9a-f]{40}/u);
    expect(workflow).not.toMatch(/uses: [^\s]+@v\d/u);
    expect(workflow).toContain("cancel-in-progress: false");
  });
});
