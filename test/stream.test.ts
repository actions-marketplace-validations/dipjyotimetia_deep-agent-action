import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { runAgentStream, type StreamActivity, type TodoItem } from "../src/agent/stream.js";

/** A fake agent whose stream yields the given "values"-mode state chunks. */
function fakeAgent(chunks: unknown[]) {
  return {
    stream: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

const opts = { threadId: "t1", debounceMs: 0, recursionLimit: 150 };

describe("runAgentStream", () => {
  test("summary is the last AI message; tokens sum over AI messages", async () => {
    const messages = [
      new HumanMessage("do the thing"),
      new AIMessage({
        content: "working…",
        usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      }),
      new AIMessage({
        content: "All done. Fixed it.",
        usage_metadata: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
      }),
    ];
    const result = await runAgentStream(fakeAgent([{ messages }]), {}, opts);

    expect(result.summary).toBe("All done. Fixed it.");
    expect(result.tokens).toEqual({ input: 17, output: 9 });
  });

  test("coerces array-of-parts message content to text", async () => {
    const messages = [
      new AIMessage({
        content: [
          { type: "text", text: "Part A" },
          { type: "text", text: " Part B" },
        ],
      }),
    ];
    const result = await runAgentStream(fakeAgent([{ messages }]), {}, opts);
    expect(result.summary).toBe("Part A Part B");
  });

  test("filters non-BaseMessage entries (graceful, never crashes)", async () => {
    const messages = [
      { role: "ai", content: "ghost (not a BaseMessage instance)" },
      new AIMessage("real summary"),
    ];
    const result = await runAgentStream(fakeAgent([{ messages }]), {}, opts);
    expect(result.summary).toBe("real summary");
  });

  test("mirrors the latest todos plan and reports it on progress", async () => {
    const seen: TodoItem[][] = [];
    const chunks = [
      { todos: [{ content: "step 1", status: "in_progress" }], messages: [] },
      { todos: [{ content: "step 1", status: "completed" }], messages: [new AIMessage("ok")] },
    ];
    const result = await runAgentStream(
      fakeAgent(chunks),
      {},
      {
        ...opts,
        onProgress: (todos) => {
          seen.push(todos);
        },
      },
    );

    expect(result.todos).toEqual([{ content: "step 1", status: "completed" }]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual([{ content: "step 1", status: "completed" }]);
  });

  test("reports typed tool activity without duplicating streamed state", async () => {
    const seen: StreamActivity[] = [];
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "search_web", args: { query: "deepagents" }, id: "call-1" },
          { name: "search_web", args: { query: "langgraph" }, id: "call-2" },
        ],
      }),
      new ToolMessage({
        content: "found it",
        name: "search_web",
        tool_call_id: "call-1",
      }),
      new ToolMessage({
        content: "found that too",
        name: "search_web",
        tool_call_id: "call-2",
      }),
    ];
    const result = await runAgentStream(
      fakeAgent([{ messages: [messages[0]] }, { messages }, { messages }]),
      {},
      {
        ...opts,
        onActivity: (activity) => {
          seen.push(activity);
        },
      },
    );

    expect(seen).toEqual([
      { type: "tool_call", name: "search_web", namespace: [], id: "call-1" },
      { type: "tool_call", name: "search_web", namespace: [], id: "call-2" },
      { type: "tool_result", name: "search_web", namespace: [], id: "call-1" },
      { type: "tool_result", name: "search_web", namespace: [], id: "call-2" },
    ]);
    expect(result.activities).toEqual(seen);
  });

  test("stops cleanly and returns pending tool requests from a HITL interrupt", async () => {
    const result = await runAgentStream(
      fakeAgent([
        {
          todos: [{ content: "publish the release", status: "in_progress" }],
          messages: [new AIMessage("I am ready to publish it.")],
          __interrupt__: [
            {
              value: {
                actionRequests: [{ name: "publish_release", args: { tag: "v1.2.3" } }],
              },
            },
          ],
        },
      ]),
      {},
      opts,
    );

    expect(result.stopped).toBe("interrupt");
    expect(result.pendingInterrupts).toEqual([
      { name: "publish_release", args: { tag: "v1.2.3" } },
    ]);
  });

  const budget = { model: "anthropic:claude-sonnet-4-6", maxTotalTokens: 200 };
  const llmEnd = (input: number, output: number) => ({
    generations: [
      [{ text: "", message: { usage_metadata: { input_tokens: input, output_tokens: output } } }],
    ],
  });

  test("budget: a meter breach aborts and reports stopped + the meter's tokens", async () => {
    // The fake stream drives the injected meter past the cap, then throws — as a
    // real cancelled LangGraph run would.
    const agent = {
      stream: async function* (_input: unknown, config: any) {
        const meter = config.callbacks[0];
        yield {
          todos: [{ content: "work", status: "in_progress" }],
          messages: [new AIMessage("…")],
        };
        meter.handleLLMEnd(llmEnd(300, 0)); // crosses the 200 cap → aborts
        throw new Error("Aborted"); // shape is irrelevant; meter.stopped drives the catch
      },
    };
    const result = await runAgentStream(agent, {}, { ...opts, budget });
    expect(result.stopped).toBe("budget");
    expect(result.tokens).toEqual({ input: 300, output: 0 });
  });

  test("budget: under the cap, completes normally with the meter's tokens", async () => {
    const agent = {
      stream: async function* (_input: unknown, config: any) {
        const meter = config.callbacks[0];
        meter.handleLLMEnd(llmEnd(50, 10));
        yield { messages: [new AIMessage("done")] };
      },
    };
    const result = await runAgentStream(agent, {}, { ...opts, budget });
    expect(result.stopped).toBeUndefined();
    expect(result.tokens).toEqual({ input: 50, output: 10 });
    expect(result.summary).toBe("done");
  });

  test("no budget: a real error still propagates (catch only swallows budget aborts)", async () => {
    const agent = {
      stream: async function* () {
        yield { messages: [] };
        throw new Error("boom");
      },
    };
    await expect(runAgentStream(agent, {}, opts)).rejects.toThrow("boom");
  });

  test("timeout: an expired runtime cap aborts and reports stopped='timeout'", async () => {
    // The fake stream waits for the timer's abort signal, then throws — as a
    // real cancelled LangGraph run would. No budget is configured, so the
    // catch must key on the timeout, not the meter.
    const agent = {
      stream: async function* (_input: unknown, config: any) {
        yield { messages: [new AIMessage("partial")] };
        await new Promise<void>((resolve) => {
          if (config.signal.aborted) return resolve();
          config.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("Aborted");
      },
    };
    const result = await runAgentStream(agent, {}, { ...opts, maxRuntimeMs: 10 });
    expect(result.stopped).toBe("timeout");
    expect(result.summary).toBe("partial");
  });

  test("timeout: an unexpired cap leaves the run untouched and real errors propagate", async () => {
    const ok = fakeAgent([{ messages: [new AIMessage("done")] }]);
    const result = await runAgentStream(ok, {}, { ...opts, maxRuntimeMs: 60_000 });
    expect(result.stopped).toBeUndefined();
    expect(result.summary).toBe("done");

    const failing = {
      stream: async function* () {
        yield { messages: [] };
        throw new Error("boom");
      },
    };
    await expect(runAgentStream(failing, {}, { ...opts, maxRuntimeMs: 60_000 })).rejects.toThrow(
      "boom",
    );
  });

  test("recursionLimit: passed through to the stream config", async () => {
    const seen: number[] = [];
    const agent = {
      stream: async function* (_input: unknown, config: any) {
        seen.push(config.recursionLimit);
        yield { messages: [] };
      },
    };
    await runAgentStream(agent, {}, opts);
    await runAgentStream(agent, {}, { ...opts, recursionLimit: 400 });
    expect(seen).toEqual([150, 400]);
  });
});
