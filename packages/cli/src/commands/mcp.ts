import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createEalClient, type EalClient } from '@eal/client';
import { readToken } from '../lib/token-store.ts';
import { logError } from '../lib/process.ts';
import type { GlobalOptions } from '../types.ts';
import { MCP_APPS } from '../apps/registry.ts';
import type { EalMcpTool } from '../apps/types.ts';

/**
 * `eal mcp` — a stdio MCP server, launched as a subprocess by `eal agent`, so
 * the Claude assistant can act on the user's data. The tool set is the union
 * of every installed app's contribution (see `apps/registry.ts`).
 */
export const EAL_TOOLS: EalMcpTool[] = MCP_APPS.flatMap((app) => app.tools);

/** Build an MCP server bound to a client. Exported so tests can drive it. */
export function createEalMcpServer(client: EalClient): Server {
  const server = new Server({ name: 'eal', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: EAL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = EAL_TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return { content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }], isError: true };
    }
    try {
      const text = await tool.run(client, request.params.arguments ?? {});
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : 'tool failed' }],
        isError: true,
      };
    }
  });

  return server;
}

/** Dispatcher: `eal mcp`. Runs the stdio MCP server until the pipe closes. */
export async function mcpCommand(global: GlobalOptions): Promise<number> {
  const token = readToken(global.tokenPathOverride);
  if (token === null) {
    // stdout is the MCP protocol channel — diagnostics go to stderr only.
    logError('eal mcp: this device is not paired — run `eal auth pair --label=<name>` first.');
    return 1;
  }
  const server = createEalMcpServer(createEalClient(global.apiUrl, { token }));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  return 0;
}
