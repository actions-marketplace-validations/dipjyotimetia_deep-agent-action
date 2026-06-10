/**
 * Validate a Deep Agent `result_json` (the RunRecord emitted as an output and
 * uploaded as the `deep-agent-run` artifact). Used by the live E2E harness to
 * assert the action produced a well-formed, audit-grade record.
 *
 * CLI:  bun run scripts/e2e/assert-result.ts [path]   (reads stdin when path omitted)
 *       env: EXPECT_STATUS (optional) — also require a specific `status`.
 */
import { readFileSync } from "node:fs";

const STATUSES = ["success", "skipped", "refused", "failed"];
const MODES = ["agent", "review", "noop"];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Structural validation of a RunRecord (shape only; values not business-checked). */
export function validateResult(obj: unknown): ValidationResult {
  const errors: string[] = [];
  if (obj == null || typeof obj !== "object") {
    return { ok: false, errors: ["result is not an object"] };
  }
  const r = obj as Record<string, unknown>;
  const req = (cond: boolean, msg: string): void => {
    if (!cond) errors.push(msg);
  };

  req(
    typeof r.status === "string" && STATUSES.includes(r.status),
    `status must be one of ${STATUSES.join("|")} (got ${JSON.stringify(r.status)})`,
  );
  req(
    typeof r.mode === "string" && MODES.includes(r.mode),
    `mode must be one of ${MODES.join("|")} (got ${JSON.stringify(r.mode)})`,
  );
  req(typeof r.model === "string" && r.model.length > 0, "model must be a non-empty string");
  req(Array.isArray(r.plan), "plan must be an array");
  req(Array.isArray(r.toolCalls), "toolCalls must be an array");
  req(Array.isArray(r.filesChanged), "filesChanged must be an array");

  if (r.tokens != null) {
    const t = r.tokens as Record<string, unknown>;
    req(
      typeof t === "object" && typeof t.input === "number" && typeof t.output === "number",
      "tokens, when present, must be { input: number, output: number }",
    );
  }
  if (r.costUsd != null)
    req(typeof r.costUsd === "number", "costUsd, when present, must be a number");
  if (r.approvalPending != null) {
    req(typeof r.approvalPending === "boolean", "approvalPending, when present, must be a boolean");
  }

  return { ok: errors.length === 0, errors };
}

/** Validate, and optionally require a specific `status`. */
export function assertResult(obj: unknown, opts: { expectStatus?: string } = {}): ValidationResult {
  const { errors } = validateResult(obj);
  const all = [...errors];
  const status = (obj as { status?: unknown } | null)?.status;
  if (opts.expectStatus && status !== opts.expectStatus) {
    all.push(`expected status ${opts.expectStatus}, got ${JSON.stringify(status)}`);
  }
  return { ok: all.length === 0, errors: all };
}

if (import.meta.main) {
  const path = process.argv[2];
  const raw = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const { ok, errors } = assertResult(parsed, { expectStatus: process.env.EXPECT_STATUS });
  if (!ok) {
    console.error("result_json validation failed:\n  - " + errors.join("\n  - "));
    process.exit(1);
  }
  const r = parsed as Record<string, unknown>;
  console.error(`result_json ok (status=${r.status}, mode=${r.mode}, model=${r.model})`);
}
