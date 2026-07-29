import { describe, expect, test } from "bun:test";
import { buildFailureRecord, resolveAuditRecordPath } from "../src/outputs.js";
import { validateResult } from "../scripts/e2e/assert-result.js";

describe("resolveAuditRecordPath", () => {
  test("uses the invocation-specific path supplied by the composite action", () => {
    expect(
      resolveAuditRecordPath({
        RUNNER_TEMP: "/runner/temp",
        DEEP_AGENT_AUDIT_PATH: "/runner/temp/deep-agent-run-agent_2.json",
      }),
    ).toBe("/runner/temp/deep-agent-run-agent_2.json");
  });

  test("retains a deterministic local fallback", () => {
    expect(resolveAuditRecordPath({ RUNNER_TEMP: "/runner/temp" })).toBe(
      "/runner/temp/deep-agent-run.json",
    );
  });
});

describe("buildFailureRecord", () => {
  test("preserves the Action output contract for failures before agent setup", () => {
    const record = buildFailureRecord("max_total_tokens must be positive", "openai:gpt-4o-mini");

    expect(record.status).toBe("failed");
    expect(record.error).toBe("max_total_tokens must be positive");
    expect(record.model).toBe("openai:gpt-4o-mini");
    expect(validateResult(record).ok).toBe(true);
  });
});
