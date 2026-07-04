import { describe, expect, test } from "bun:test";
import { parseFindings, formatFindingBody } from "../src/github/review.js";

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
