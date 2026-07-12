import { describe, expect, test } from "bun:test";
import { FakeToolCallingModel, tool } from "langchain";
import { z } from "zod";
import { buildAgent } from "../src/agent/createAgent.js";
import { runAgentStream } from "../src/agent/stream.js";

describe("deepagents HITL integration", () => {
  test("surfaces an MCP interrupt instead of failing for a missing checkpointer", async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [[{ name: "publish_release", args: { tag: "v1.2.3" }, id: "publish-1" }]],
    });
    const publish = tool(async () => "published", {
      name: "publish_release",
      description: "Publish a release.",
      schema: z.object({ tag: z.string() }),
    });
    const agent = buildAgent({
      model,
      modelSpec: "anthropic:test-model",
      rootDir: process.cwd(),
      systemPrompt: "test",
      allowedCommands: ["echo"],
      deniedCommands: [],
      shellTimeoutSeconds: 5,
      toolCallRecord: [],
      extraTools: [publish],
      interruptOn: { publish_release: true },
    });

    const result = await runAgentStream(
      agent,
      { messages: [{ role: "user", content: "publish the release" }] },
      { threadId: "hitl-test", debounceMs: 0, recursionLimit: 10 },
    );

    expect(result.stopped).toBe("interrupt");
    expect(result.pendingInterrupts).toEqual([
      { name: "publish_release", args: { tag: "v1.2.3" } },
    ]);
  });
});
