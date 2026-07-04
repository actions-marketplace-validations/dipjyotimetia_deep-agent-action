import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFindings,
  formatFindingBody,
  applySuggestion,
  partitionApplicableFindings,
  applyReviewSuggestions,
} from "../src/github/review.js";

describe("parseFindings", () => {
  test("parses well-formed findings", () => {
    const r = parseFindings({
      summary: "Looks mostly good.",
      findings: [
        { path: "src/a.ts", line: 12, body: "Off-by-one here." },
        { path: "src/b.ts", line: 3, body: "Unused import." },
      ],
    });
    expect(r.summary).toBe("Looks mostly good.");
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toEqual({ path: "src/a.ts", line: 12, body: "Off-by-one here." });
  });

  test("drops incomplete findings", () => {
    const r = parseFindings({
      findings: [
        { path: "src/a.ts", line: 0, body: "no line" },
        { path: "", line: 5, body: "no path" },
        { path: "src/c.ts", line: 9, body: "" },
        { path: "src/d.ts", line: 4, body: "valid" },
      ],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.path).toBe("src/d.ts");
  });

  test("tolerates missing/garbage input", () => {
    expect(parseFindings(null)).toEqual({ summary: "", findings: [] });
    expect(parseFindings({ findings: "nope" })).toEqual({ summary: "", findings: [] });
  });

  test("salvages valid findings around a malformed (non-object) element", () => {
    const r = parseFindings({ findings: [null, 42, { path: "a.ts", line: 1, body: "x" }] });
    expect(r.findings).toEqual([{ path: "a.ts", line: 1, body: "x" }]);
  });

  test("accepts valid severities, normalizing case", () => {
    const r = parseFindings({
      findings: [
        { path: "a.ts", line: 1, body: "x", severity: "critical" },
        { path: "b.ts", line: 2, body: "y", severity: "WARNING" },
        { path: "c.ts", line: 3, body: "z", severity: " info " },
      ],
    });
    expect(r.findings.map((f) => f.severity)).toEqual(["critical", "warning", "info"]);
  });

  test("drops an invalid severity without dropping the finding", () => {
    const r = parseFindings({
      findings: [
        { path: "a.ts", line: 1, body: "x", severity: "blocker" },
        { path: "b.ts", line: 2, body: "y", severity: 42 },
      ],
    });
    expect(r.findings).toHaveLength(2);
    expect(r.findings.every((f) => f.severity === undefined)).toBe(true);
  });

  test("keeps a non-empty string suggestion, discards empty/non-string ones", () => {
    const r = parseFindings({
      findings: [
        { path: "a.ts", line: 1, body: "x", suggestion: "const y = 1;" },
        { path: "b.ts", line: 2, body: "y", suggestion: "   " },
        { path: "c.ts", line: 3, body: "z", suggestion: 42 },
      ],
    });
    expect(r.findings[0]!.suggestion).toBe("const y = 1;");
    expect(r.findings[1]!.suggestion).toBeUndefined();
    expect(r.findings[2]!.suggestion).toBeUndefined();
  });
});

describe("formatFindingBody", () => {
  test("renders a bold severity prefix per level, none when unset", () => {
    expect(formatFindingBody({ path: "a", line: 1, body: "b", severity: "critical" })).toBe(
      "**[Critical]** b",
    );
    expect(formatFindingBody({ path: "a", line: 1, body: "b", severity: "warning" })).toBe(
      "**[Warning]** b",
    );
    expect(formatFindingBody({ path: "a", line: 1, body: "b", severity: "info" })).toBe(
      "**[Info]** b",
    );
    expect(formatFindingBody({ path: "a", line: 1, body: "b" })).toBe("b");
  });

  test("appends a GitHub suggestion fence when a suggestion is present", () => {
    const out = formatFindingBody({
      path: "a.ts",
      line: 1,
      body: "Off-by-one.",
      suggestion: "for (let i = 0; i < n; i++) {",
    });
    expect(out).toBe("Off-by-one.\n\n```suggestion\nfor (let i = 0; i < n; i++) {\n```");
  });

  test("uses a longer outer fence when the suggestion itself contains ```", () => {
    const out = formatFindingBody({
      path: "README.md",
      line: 1,
      body: "Fix the fence.",
      suggestion: "```js\nconsole.log(1);\n```",
    });
    expect(out).toContain("````suggestion\n");
    expect(out.endsWith("````")).toBe(true);
  });
});

describe("applySuggestion", () => {
  test("replaces the given 1-based line verbatim", () => {
    expect(applySuggestion("a\nb\nc", 2, "B")).toBe("a\nB\nc");
  });

  test("returns the text unchanged when the line is out of range", () => {
    expect(applySuggestion("a\nb", 5, "X")).toBe("a\nb");
    expect(applySuggestion("a\nb", 0, "X")).toBe("a\nb");
  });
});

describe("partitionApplicableFindings", () => {
  test("splits findings with a usable suggestion from those without", () => {
    const withSuggestion = { path: "a.ts", line: 1, body: "x", suggestion: "const a = 1;" };
    const noSuggestion = { path: "b.ts", line: 2, body: "y" };
    const badLine = { path: "c.ts", line: 0, body: "z", suggestion: "ignored, bad line" };
    const { applicable, unhandled } = partitionApplicableFindings([
      withSuggestion,
      noSuggestion,
      badLine,
    ]);
    expect(applicable).toEqual([withSuggestion]);
    expect(unhandled).toEqual([noSuggestion, badLine]);
  });
});

describe("applyReviewSuggestions", () => {
  function withTempFile(contents: string, fn: (rootDir: string, relPath: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "deep-agent-review-"));
    const relPath = "src/foo.ts";
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, relPath), contents);
    fn(dir, relPath);
  }

  test("applies suggestions highest-line-first so earlier edits don't shift pending line numbers", () => {
    withTempFile("line1\nline2\nline3\n", (dir, relPath) => {
      const findings = [
        { path: relPath, line: 1, body: "fix 1", suggestion: "LINE1" },
        { path: relPath, line: 3, body: "fix 3", suggestion: "LINE3" },
      ];
      const { applied, unhandled } = applyReviewSuggestions(dir, findings);
      expect(applied).toHaveLength(2);
      expect(unhandled).toHaveLength(0);
      expect(readFileSync(join(dir, relPath), "utf8")).toBe("LINE1\nline2\nLINE3\n");
    });
  });

  test("moves findings for a missing file to unhandled instead of applying", () => {
    const dir = mkdtempSync(join(tmpdir(), "deep-agent-review-"));
    const findings = [{ path: "does/not/exist.ts", line: 1, body: "x", suggestion: "y" }];
    const { applied, unhandled } = applyReviewSuggestions(dir, findings);
    expect(applied).toHaveLength(0);
    expect(unhandled).toEqual(findings);
  });

  test("findings without a suggestion are always unhandled", () => {
    const dir = mkdtempSync(join(tmpdir(), "deep-agent-review-"));
    const findings = [{ path: "a.ts", line: 1, body: "x" }];
    const { applied, unhandled } = applyReviewSuggestions(dir, findings);
    expect(applied).toHaveLength(0);
    expect(unhandled).toEqual(findings);
  });
});
