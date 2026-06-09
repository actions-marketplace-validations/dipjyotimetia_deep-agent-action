import { describe, expect, test } from "bun:test";
import { parseFindings } from "../src/github/review.js";

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
});
