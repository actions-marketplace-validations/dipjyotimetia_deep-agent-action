import * as core from "@actions/core";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STOP_LABELS } from "./github/comments.js";
import type { RunRecord } from "./types.js";

/** Resolve the per-invocation audit path supplied by the composite action. */
export function resolveAuditRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DEEP_AGENT_AUDIT_PATH) return env.DEEP_AGENT_AUDIT_PATH;
  return join(env.RUNNER_TEMP || tmpdir(), "deep-agent-run.json");
}

/** Build a valid output record when orchestration fails before agent setup. */
export function buildFailureRecord(error: string, model: string): RunRecord {
  return {
    status: "failed",
    mode: "noop",
    model: model || "unknown",
    plan: [],
    toolCalls: [],
    filesChanged: [],
    error,
  };
}

/** Emit Action outputs, a run summary, and the retained audit record file. */
export async function emitOutputs(record: RunRecord): Promise<void> {
  core.setOutput("status", record.status);
  core.setOutput("pr_url", record.prUrl ?? "");
  core.setOutput("branch", record.branch ?? "");
  core.setOutput("budget_stopped", record.stopReason === "budget" ? "true" : "false");
  core.setOutput("timed_out", record.stopReason === "timeout" ? "true" : "false");
  core.setOutput("stalled", record.stopReason === "stalled" ? "true" : "false");
  core.setOutput("interrupted", record.stopReason === "interrupt" ? "true" : "false");
  core.setOutput("result_json", JSON.stringify(record));

  await writeSummary(record);
  writeAuditRecord(record);
}

async function writeSummary(record: RunRecord): Promise<void> {
  try {
    const s = core.summary.addRaw(`## Deep Agent — ${record.status}\n`, true);
    if (record.instruction) s.addRaw(`**Request:** ${record.instruction}\n`, true);
    s.addRaw(`**Model:** \`${record.model}\`\n`, true);
    if (record.plan.length) {
      s.addRaw("**Plan**\n", true);
      for (const t of record.plan) {
        s.addRaw(`- ${t.status === "completed" ? "[x]" : "[ ]"} ${t.content}\n`, true);
      }
    }
    if (record.filesChanged.length) {
      s.addRaw(`**Files changed:** ${record.filesChanged.length}\n`, true);
    }
    if (record.prUrl) s.addRaw(`**Pull request:** ${record.prUrl}\n`, true);
    if (record.tokens && (record.tokens.input || record.tokens.output)) {
      const cost = record.costUsd != null ? ` (~$${record.costUsd.toFixed(4)})` : "";
      s.addRaw(
        `**Tokens:** ${record.tokens.input} in / ${record.tokens.output} out${cost}\n`,
        true,
      );
    }
    if (record.stopReason) {
      s.addRaw(
        `**Stopped early:** at the configured ${STOP_LABELS[record.stopReason]}; partial work opened for review.\n`,
        true,
      );
    }
    if (record.stopDetail) s.addRaw(`**Stop detail:** ${record.stopDetail}\n`, true);
    if (record.error) s.addRaw(`**Error:** ${record.error}\n`, true);
    await s.write();
  } catch {
    // Summary is best-effort.
  }
}

// Write the run record to RUNNER_TEMP for the action's `actions/upload-artifact`
// step to publish as the `deep-agent-run` artifact. The upload can't happen
// in-process: ACTIONS_RUNTIME_TOKEN isn't exposed to composite `run:` steps, so
// only a JS action step (upload-artifact) can authenticate to the artifact API.
function writeAuditRecord(record: RunRecord): void {
  try {
    writeFileSync(resolveAuditRecordPath(), JSON.stringify(record, null, 2), "utf8");
  } catch {
    // Best-effort; never fail the run over the audit record file.
  }
}
