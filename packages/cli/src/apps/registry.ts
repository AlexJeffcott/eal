import { familyPhoneMcpApp } from './family-phone.ts';
import { tasksMcpApp } from './tasks.ts';
import type { CliMcpApp } from './types.ts';

/**
 * Every installed app's assistant tools. `eal mcp` serves the union. Add an
 * app's tools by adding it here.
 */
export const MCP_APPS: readonly CliMcpApp[] = [tasksMcpApp, familyPhoneMcpApp];
