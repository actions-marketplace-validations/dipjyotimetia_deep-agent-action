import {
  CompositeBackend,
  createDeepAgent,
  LocalShellBackend,
  registerHarnessProfile,
  type FilesystemPermission,
  type HarnessProfile,
} from "deepagents";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import type { ToolCallRecord } from "../types.js";
import { createShellGuard } from "./shellGuard.js";
import { buildShellEnv } from "./env.js";
import {
  buildFilesystemPermissions,
  buildInterruptPolicy,
  discoverDeepAgentSources,
} from "./policy.js";
import type { InterruptPolicy } from "./policy.js";

export interface BuildAgentOptions {
  model: BaseChatModel;
  rootDir: string;
  systemPrompt: string;
  allowedCommands: string[];
  deniedCommands: string[];
  shellTimeoutSeconds: number;
  /** Provider-prefixed model id used to register a custom harness profile. */
  modelSpec?: string;
  /** Optional validated deepagents harness profile. */
  harnessProfile?: HarnessProfile;
  /** Optional filesystem permission rules layered below the memory write-protection floor. */
  filesystemPermissions?: FilesystemPermission[];
  /** Optional tool interrupt rules; MCP tools are interrupted by default. */
  interruptOn?: InterruptPolicy;
  /** Mutable sink the shell guard appends tool-call records to. */
  toolCallRecord: ToolCallRecord[];
  /** Extra tools (e.g. from MCP servers) added alongside the built-in tools. */
  extraTools?: DynamicStructuredTool[];
}

export interface ResolveAgentPolicyOptions {
  rootDir: string;
  mcpToolNames: string[];
  filesystemPermissions?: FilesystemPermission[];
  interruptOn?: InterruptPolicy;
}

/**
 * Turn the action's provider-prefixed model id into a deepagents-compatible
 * exact profile key. Bedrock ids can contain a second colon, while deepagents
 * profile keys accept only `provider:model`.
 */
function profileLookupKey(modelSpec: string): string | undefined {
  const separator = modelSpec.indexOf(":");
  if (separator <= 0 || separator === modelSpec.length - 1) return undefined;
  const provider = modelSpec.slice(0, separator);
  const model = modelSpec.slice(separator + 1).replaceAll(":", "_");
  return `${provider}:${model}`;
}

/** Resolve repository sources and deepagents policy before constructing the graph. */
export function resolveAgentPolicy(opts: ResolveAgentPolicyOptions): {
  memory?: string[];
  skills?: string[];
  permissions: FilesystemPermission[];
  interruptOn?: InterruptPolicy;
} {
  const sources = discoverDeepAgentSources(opts.rootDir);
  const interruptOn = buildInterruptPolicy(opts.mcpToolNames, opts.interruptOn);
  return {
    memory: sources.memory,
    skills: sources.skills,
    permissions: buildFilesystemPermissions(opts.filesystemPermissions),
    interruptOn: Object.keys(interruptOn).length ? interruptOn : undefined,
  };
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
  const shellBackend = new LocalShellBackend({
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

  if (opts.harnessProfile) {
    const profileKeys = new Set<string>();
    // deepagents resolves profiles from the concrete LangChain model class.
    // OpenRouter and openai-compatible models are ChatOpenAI instances, so
    // register the OpenAI alias as well as the user-facing provider key.
    const modelName = opts.model.getName();
    if (modelName === "ChatAnthropic") profileKeys.add("anthropic");
    if (modelName === "ChatOpenAI") profileKeys.add("openai");
    if (modelName === "ChatGoogleGenerativeAI") profileKeys.add("google");

    // Some supported LangChain adapters (notably Bedrock and Vertex) do not
    // expose a provider name that deepagents can infer. Register a sanitized
    // exact key and supply it through LangChain's optional `model_name`
    // metadata field. This leaves the provider's real `model` request field
    // untouched while making the profile apply instead of silently no-oping.
    if (opts.modelSpec) {
      const exactKey = profileLookupKey(opts.modelSpec);
      if (exactKey) {
        registerHarnessProfile(exactKey, opts.harnessProfile);
        if (!profileKeys.size) {
          const modelWithMetadata = opts.model as BaseChatModel & { model_name?: unknown };
          if (modelWithMetadata.model_name === undefined) {
            modelWithMetadata.model_name = exactKey;
          }
        }
      }
      const separator = opts.modelSpec.indexOf(":");
      if (separator > 0) profileKeys.add(opts.modelSpec.slice(0, separator));
    }
    for (const key of profileKeys) registerHarnessProfile(key, opts.harnessProfile);
  }

  const policy = resolveAgentPolicy({
    rootDir: opts.rootDir,
    mcpToolNames: (opts.extraTools ?? []).map((tool) => tool.name),
    filesystemPermissions: opts.filesystemPermissions,
    interruptOn: opts.interruptOn,
  });

  // deepagents rejects filesystem permissions on a raw shell backend because
  // shell commands can bypass path rules. A root composite route makes the
  // permission scope explicit while keeping execute delegated to the same
  // LocalShellBackend (and preserving virtualMode path containment).
  const backend = new CompositeBackend(shellBackend, { "/": shellBackend });

  return createDeepAgent({
    model: opts.model,
    backend,
    systemPrompt: opts.systemPrompt,
    middleware: [shellGuard],
    tools: opts.extraTools ?? [],
    memory: policy.memory,
    skills: policy.skills,
    permissions: policy.permissions,
    interruptOn: policy.interruptOn,
    // LangGraph's interrupt primitive requires a checkpointer even when the
    // workflow intentionally does not support cross-run resume. A fresh
    // in-memory saver is scoped to this runner invocation.
    checkpointer: policy.interruptOn ? new MemorySaver() : undefined,
  });
}
