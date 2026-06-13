import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { runAgentStream, type TodoItem } from "../src/agent/stream.js";

/** A fake agent whose stream yields the given "values"-mode state chunks. */
function fakeAgent(chunks: unknown[]) {
  return {
    stream: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

const opts = { threadId: "t1", debounceMs: 0 };

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
});
