import { createDeepAgent, LocalShellBackend } from "deepagents";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { DynamicStructuredTool } from "@langchain/core/tools";
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
  /** Extra tools (e.g. from MCP servers) added alongside the built-in tools. */
  extraTools?: DynamicStructuredTool[];
}

/**
 * Assemble the in-runner Deep Agent: a LocalShellBackend rooted at the
 * workspace (which enables the built-in `execute` tool), an instantiated
 * model, and the command allow-list middleware.
 */
export function buildAgent(opts: BuildAgentOptions) {
  // Sandbox the built-in filesystem tools (ls/glob/grep/read/edit) to the
  // workspace via `virtualMode`. With the default (virtualMode=false) those
  // tools accept arbitrary absolute paths, so an exploratory model can glob
  // outside the repo — and deepagents' fast-glob calls are not wrapped in
  // try/catch, which means an unreadable directory (e.g. `/home/packer` on the
  // GitHub runner image) throws EACCES and crashes the whole run. In virtual
  // mode absolute paths are treated as virtual paths under rootDir and anything
  // resolving outside the root is returned empty/error to the model instead of
  // reaching the filesystem. The `execute` (shell) tool is NOT affected — it
  // keeps full system access, gated by the command allow/deny list.
  const backend = new LocalShellBackend({
    rootDir: opts.rootDir,
    virtualMode: true,
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
    tools: opts.extraTools ?? [],
  });
}
