import * as core from "@actions/core";
import artifactClient from "@actions/artifact";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "./types.js";

/** Emit Action outputs, a run summary, and the retained audit artifact. */
export async function emitOutputs(record: RunRecord): Promise<void> {
  core.setOutput("status", record.status);
  core.setOutput("pr_url", record.prUrl ?? "");
  core.setOutput("branch", record.branch ?? "");
  core.setOutput("result_json", JSON.stringify(record));

  await writeSummary(record);
  await uploadAuditRecord(record);
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
    if (record.error) s.addRaw(`**Error:** ${record.error}\n`, true);
    await s.write();
  } catch {
    // Summary is best-effort.
  }
}

async function uploadAuditRecord(record: RunRecord): Promise<void> {
  try {
    const dir = process.env.RUNNER_TEMP || tmpdir();
    const file = join(dir, "deep-agent-run.json");
    writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
    await artifactClient.uploadArtifact("deep-agent-run", [file], dir);
  } catch {
    // Artifact upload requires a real runner; never fail the run over it.
  }
}
