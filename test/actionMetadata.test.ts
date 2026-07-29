import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

type Step = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  with?: Record<string, unknown>;
};

function workflow(path: string): any {
  return parse(readFileSync(path, "utf8"));
}

describe("composite action metadata", () => {
  const metadata = workflow("action.yml");
  const steps = metadata.runs.steps as Step[];

  test("installs the production dependency graph from the committed lockfile", () => {
    const install = steps.find((step) => step.name === "Install action dependencies");
    expect(install?.run).toBe("bun install --production --frozen-lockfile");
  });

  test("isolates audit files and artifacts per action invocation", () => {
    const initialize = steps.find((step) => step.name === "Initialize audit record");
    const run = steps.find((step) => step.name === "Run Deep Agent");
    const upload = steps.find((step) => step.name === "Upload audit record");

    expect(initialize?.run).toContain("crypto.randomUUID()");
    expect(metadata.outputs.audit_artifact.value).toBe("${{ steps.audit.outputs.artifact_name }}");
    expect(run?.env?.DEEP_AGENT_AUDIT_PATH).toBe("${{ steps.audit.outputs.audit_path }}");
    expect(run?.env?.DEEP_AGENT_INVOCATION_ID).toBe("${{ steps.audit.outputs.audit_id }}");
    expect(upload?.with?.name).toBe("${{ steps.audit.outputs.artifact_name }}");
    expect(upload?.with?.path).toBe("${{ steps.audit.outputs.audit_path }}");
    expect(upload?.with?.overwrite).toBeUndefined();
  });
});

describe("repository CI metadata", () => {
  const ci = workflow(".github/workflows/ci.yml");
  const steps = ci.jobs.build.steps as Step[];

  test("uses the same Bun version as the shipped action and audits dependencies", () => {
    const setup = steps.find((step) => step.uses === "oven-sh/setup-bun@v2");
    expect(setup?.with?.["bun-version"]).toBe("1.3.14");
    expect(steps.some((step) => step.run === "bun audit")).toBe(true);
  });
});

describe("dispatch E2E metadata", () => {
  const e2e = workflow(".github/workflows/e2e.yml");
  const steps = e2e.jobs.implement.steps as Step[];

  test("downloads the audit artifact name emitted by the action invocation", () => {
    const download = steps.find((step) => step.name === "Download audit artifact");
    const validate = steps.find((step) => step.name === "Validate audit artifact");

    expect(download?.with?.name).toBe("${{ steps.agent.outputs.audit_artifact }}");
    expect(validate?.run).toContain("${{ steps.agent.outputs.audit_artifact }}.json");
  });
});
