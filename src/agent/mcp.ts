import * as core from "@actions/core";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";

export interface McpHandle {
  tools: DynamicStructuredTool[];
  close: () => Promise<void>;
}

const EMPTY: McpHandle = { tools: [], close: async () => {} };

/**
 * Load tools from MCP servers described by an `mcp_config` JSON string
 * (`{ "mcpServers": { name: { command, args, env } | { url } } }`).
 *
 * Best-effort: invalid JSON or a server that fails to connect logs a warning
 * and yields no tools, so a broken MCP config never aborts the run. The config
 * is workflow-author-controlled (not from untrusted issue text).
 */
export async function loadMcpTools(configJson: string): Promise<McpHandle> {
  if (!configJson.trim()) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch (err) {
    core.warning(
      `Ignoring mcp_config: invalid JSON (${err instanceof Error ? err.message : err}).`,
    );
    return EMPTY;
  }

  try {
    const client = new MultiServerMCPClient(
      parsed as ConstructorParameters<typeof MultiServerMCPClient>[0],
    );
    const tools = await client.getTools();
    core.info(`Loaded ${tools.length} MCP tool(s).`);
    return { tools, close: () => client.close() };
  } catch (err) {
    core.warning(`Failed to load MCP tools: ${err instanceof Error ? err.message : err}.`);
    return EMPTY;
  }
}
