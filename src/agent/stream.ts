export interface TodoItem {
  content: string;
  status: string;
}

export interface StreamResult {
  todos: TodoItem[];
  summary: string;
}

/** Coerce LangChain message content (string | array of parts) to plain text. */
function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("");
  }
  return "";
}

/** Return the message type ("ai", "tool", ...) across LangChain versions. */
function messageType(msg: any): string | undefined {
  return msg?.getType?.() ?? msg?._getType?.() ?? msg?.type;
}

/** Normalize a streamed item into { namespace, state } regardless of tuple shape. */
function extractState(item: unknown): { namespace: unknown[]; state: any } {
  if (Array.isArray(item)) {
    const namespace = Array.isArray(item[0]) ? (item[0] as unknown[]) : [];
    return { namespace, state: item[item.length - 1] };
  }
  return { namespace: [], state: item };
}

function mapTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t: any) => ({
    content: String(t?.content ?? ""),
    status: String(t?.status ?? "pending"),
  }));
}

/**
 * Drive the agent via streaming, mirroring plan/progress as it goes.
 *
 * Uses "values" mode so each chunk carries the full state (latest `todos` and
 * `messages`). Progress is mirrored through `onProgress`, debounced by
 * `debounceMs` and only when the plan changes; a final mirror always runs.
 */
export async function runAgentStream(
  agent: { stream: (input: any, options?: any) => any },
  input: any,
  options: {
    threadId: string;
    onProgress?: (todos: TodoItem[]) => Promise<void> | void;
    debounceMs: number;
  },
): Promise<StreamResult> {
  let todos: TodoItem[] = [];
  let summary = "";
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
    const isMain = namespace.length === 0;

    if (isMain && Array.isArray(state.todos)) {
      todos = mapTodos(state.todos);
    }
    if (isMain && Array.isArray(state.messages)) {
      for (const msg of state.messages) {
        if (messageType(msg) === "ai") {
          const text = contentToString(msg.content).trim();
          if (text) summary = text;
        }
      }
    }

    if (isMain && options.onProgress) {
      const key = JSON.stringify(todos);
      const now = Date.now();
      if (key !== lastMirrorKey && now - lastMirrorAt >= options.debounceMs) {
        lastMirrorKey = key;
        lastMirrorAt = now;
        await options.onProgress(todos);
      }
    }
  }

  // Final mirror so the closing plan state is always reflected.
  if (options.onProgress && JSON.stringify(todos) !== lastMirrorKey) {
    await options.onProgress(todos);
  }

  return { todos, summary };
}
