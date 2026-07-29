import { LocalShellBackend, type ExecuteResponse, type LocalShellBackendOptions } from "deepagents";
import type { ToolCallRecord } from "../types.js";

/** Strip a leading directory path, leaving the executable basename. */
function basename(token: string): string {
  const cleaned = token.replace(/^['"]|['"]$/g, "");
  const slash = cleaned.lastIndexOf("/");
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

/** Split a shell command into segments separated by operators. */
function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[|;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The first executable token of a segment, skipping leading VAR=value assignments. */
function segmentCommand(segment: string): string | undefined {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  const exe = tokens[i];
  return exe ? basename(exe) : undefined;
}

export interface CommandVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a shell command may run.
 *
 * Each operator-separated segment's executable must be in the allow-list and
 * not in the deny-list. A global token scan additionally rejects any denied
 * command appearing anywhere (e.g. inside `$(...)`).
 *
 * This is a guardrail that bounds the blast radius of an injected instruction —
 * not a sandbox. The real isolation comes from the agent's curated, secret-free
 * shell environment (and the P2 sandbox backend).
 */
export function evaluateCommand(
  command: string,
  allowed: string[],
  denied: string[],
): CommandVerdict {
  const cmd = (command ?? "").trim();
  if (!cmd) return { allowed: false, reason: "Empty command." };

  const allowSet = new Set(allowed);
  const denySet = new Set(denied);

  // Per-segment executable check.
  for (const segment of splitSegments(cmd)) {
    const base = segmentCommand(segment);
    if (!base) continue;
    if (denySet.has(base)) {
      return { allowed: false, reason: `Command \`${base}\` is on the deny-list.` };
    }
    if (!allowSet.has(base)) {
      return {
        allowed: false,
        reason: `Command \`${base}\` is not on the allow-list. Allowed: ${allowed.join(", ")}.`,
      };
    }
  }

  // Global token scan for denied commands hidden in substitutions/args.
  for (const token of cmd.split(/[\s'"()`$]+/).filter(Boolean)) {
    if (denySet.has(basename(token))) {
      return { allowed: false, reason: `Command \`${basename(token)}\` is on the deny-list.` };
    }
  }

  return { allowed: true };
}

export interface ShellGuardOptions {
  allowed: string[];
  denied: string[];
  record: ToolCallRecord[];
}

/**
 * Local shell backend that enforces and audits command policy at the execution
 * boundary shared by the main agent and every delegated subagent.
 */
export class GuardedLocalShellBackend extends LocalShellBackend {
  constructor(
    backendOptions: LocalShellBackendOptions,
    private readonly guardOptions: ShellGuardOptions,
  ) {
    super(backendOptions);
  }

  override async execute(command: string): Promise<ExecuteResponse> {
    const verdict = evaluateCommand(command, this.guardOptions.allowed, this.guardOptions.denied);
    this.guardOptions.record.push({
      name: "execute",
      args: { command },
      blocked: !verdict.allowed,
      reason: verdict.reason,
    });

    if (!verdict.allowed) {
      return {
        output: `Command blocked by policy: ${verdict.reason} The command was not executed.`,
        exitCode: 126,
        truncated: false,
      };
    }

    return super.execute(command);
  }
}
