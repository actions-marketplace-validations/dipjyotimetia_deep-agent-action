import { isAIMessage, isBaseMessage } from "@langchain/core/messages";
import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import type { TokenUsage } from "../types.js";

export interface TodoItem {
  content: string;
  status: string;
}

export interface StreamResult {
  todos: TodoItem[];
  summary: string;
  tokens: TokenUsage;
}

/** Coerce LangChain message content (string | array of parts) to plain text. */
function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      typeof part !== "string" && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

/** Normalize a streamed item into { namespace, state } regardless of tuple shape. */
function extractState(item: unknown): { namespace: unknown[]; state: unknown } {
  if (Array.isArray(item)) {
    const namespace = Array.isArray(item[0]) ? (item[0] as unknown[]) : [];
    return { namespace, state: item[item.length - 1] };
  }
  return { namespace: [], state: item };
}

function mapTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t: unknown) => {
    const r = (t ?? {}) as { content?: unknown; status?: unknown };
    return {
      content: String(r.content ?? ""),
      status: String(r.status ?? "pending"),
    };
  });
}

/**
 * Drive the agent via streaming, mirroring plan/progress as it goes.
 *
 * Uses "values" mode so each chunk carries the full state (latest `todos` and
 * `messages`). Progress is mirrored through `onProgress`, debounced by
 * `debounceMs` and only when the plan changes; a final mirror always runs.
 */
export async function runAgentStream(
  // The DeepAgent harness types its stream input as a complex, version-specific
  // state type; `any` here keeps the call site assignable across versions. The
  // result is narrowed to an async iterable since we only `for await` over it.
  agent: {
    stream: (input: any, options?: any) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  },
  input: unknown,
  options: {
    threadId: string;
    onProgress?: (todos: TodoItem[]) => Promise<void> | void;
    debounceMs: number;
  },
): Promise<StreamResult> {
  let todos: TodoItem[] = [];
  let todosKey = "";
  let finalMessages: BaseMessage[] = [];
  let lastMirrorKey = "";
  let lastMirrorAt = 0;

  const stream = await agent.stream(input, {
    configurable: { thread_id: options.threadId },
    streamMode: "values",
    subgraphs: true,
    // A coding loop (read → edit → test → fix) easily exceeds LangGraph's
    // default of 25 super-steps; raise it so real tasks don't abort mid-run.
    recursionLimit: 150,
  });

  for await (const item of stream) {
    const { namespace, state } = extractState(item);
    if (!state || typeof state !== "object") continue;
    // Only the main agent (empty namespace) drives the canonical plan/summary.
    if (namespace.length !== 0) continue;

    const s = state as { todos?: unknown; messages?: unknown };
    if (Array.isArray(s.todos)) {
      todos = mapTodos(s.todos);
      todosKey = JSON.stringify(todos); // re-keyed only when the plan changes
    }
    if (Array.isArray(s.messages)) finalMessages = s.messages.filter(isBaseMessage);

    if (options.onProgress) {
      const now = Date.now();
      if (todosKey !== lastMirrorKey && now - lastMirrorAt >= options.debounceMs) {
        lastMirrorKey = todosKey;
        lastMirrorAt = now;
        await options.onProgress(todos);
      }
    }
  }

  // Final mirror so the closing plan state is always reflected.
  if (options.onProgress && todosKey !== lastMirrorKey) {
    await options.onProgress(todos);
  }

  return { todos, summary: lastAiText(finalMessages), tokens: sumTokens(finalMessages) };
}

/** Sum input/output tokens across all AI messages in the final state. */
function sumTokens(messages: BaseMessage[]): TokenUsage {
  let input = 0;
  let output = 0;
  for (const msg of messages) {
    if (isAIMessage(msg) && msg.usage_metadata) {
      input += msg.usage_metadata.input_tokens ?? 0;
      output += msg.usage_metadata.output_tokens ?? 0;
    }
  }
  return { input, output };
}

/** The text of the last AI message in the final state (the agent's closing summary). */
function lastAiText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && isAIMessage(msg)) {
      const text = contentToString(msg.content).trim();
      if (text) return text;
    }
  }
  return "";
}
