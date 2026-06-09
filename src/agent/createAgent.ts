import { createDeepAgent, LocalShellBackend } from "deepagents";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ToolCallRecord } from "../types.js";
import { createShellGuard } from "./shellGuard.js";
import { buildShellEnv } from "./env.js";

export interface BuildAgentOptions {
  model: BaseChatModel;
  rootDir: string;
  systemPrompt: string;
  allowedCommands: string[];
  deniedCommands: string[];
  shellTimeoutSeconds: number;
  /** Mutable sink the shell guard appends tool-call records to. */
  toolCallRecord: ToolCallRecord[];
}

/**
 * Assemble the in-runner Deep Agent: a LocalShellBackend rooted at the
 * workspace (which enables the built-in `execute` tool), an instantiated
 * model, and the command allow-list middleware.
 */
export function buildAgent(opts: BuildAgentOptions) {
  const backend = new LocalShellBackend({
    rootDir: opts.rootDir,
    env: buildShellEnv(),
    timeout: opts.shellTimeoutSeconds,
    maxOutputBytes: 200_000,
  });

  const shellGuard = createShellGuard({
    allowed: opts.allowedCommands,
    denied: opts.deniedCommands,
    record: opts.toolCallRecord,
  });

  return createDeepAgent({
    model: opts.model,
    backend,
    systemPrompt: opts.systemPrompt,
    middleware: [shellGuard],
  });
}
