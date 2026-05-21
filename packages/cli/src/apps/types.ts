import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { EalClient } from '@eal/client';

/** One MCP tool the assistant can call, plus its executor. */
export interface EalMcpTool {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  run: (client: EalClient, args: Record<string, unknown>) => Promise<string>;
}

/**
 * An app's contribution to the assistant: the MCP tools it exposes. `eal mcp`
 * serves the union of every installed app's tools.
 */
export interface CliMcpApp {
  id: string;
  tools: EalMcpTool[];
}
