#!/usr/bin/env bun
import { BIN_NAME, CLI_VERSION, DEFAULT_API_URL } from './lib/runtime.ts';
import { log, logError } from './lib/process.ts';
import { splitArgs } from './lib/split-args.ts';
import type { GlobalOptions } from './types.ts';

interface CommandSpec {
  description: string;
  handler: (global: GlobalOptions) => Promise<number>;
}

const COMMANDS: Record<string, CommandSpec> = {
  auth: {
    description: 'Sign in/out (subcommands: login | status | logout | pair)',
    handler: async (global) => {
      const { authCommand } = await import('./commands/auth.ts');
      return authCommand(global);
    },
  },
  agent: {
    description: 'Run the assistant worker — lets the web app chat with Claude',
    handler: async (global) => {
      const { agentCommand } = await import('./commands/agent.ts');
      return agentCommand(global);
    },
  },
  mcp: {
    description: 'Run the eal task tool server (stdio MCP; launched by `eal agent`)',
    handler: async (global) => {
      const { mcpCommand } = await import('./commands/mcp.ts');
      return mcpCommand(global);
    },
  },
};

function printHelp(): void {
  log(`${BIN_NAME} ${CLI_VERSION} — local CLI`);
  log('');
  log(`Usage: ${BIN_NAME} [global-options] <command> [command-args]`);
  log('');
  log('Commands:');
  for (const [name, spec] of Object.entries(COMMANDS)) {
    log(`  ${name.padEnd(10)} ${spec.description}`);
  }
  log('');
  log('Global options:');
  log(`  --api-url <url>        api base URL (default ${DEFAULT_API_URL})`);
  log('  --token-path <path>    override token file path');
  log('  --json                 emit JSON output where applicable');
  log('  --verbose, -v          extra diagnostic output');
  log('  --help, -h             show this help');
  log('');
  log('Env fallbacks:');
  log('  EAL_API_URL                       same as --api-url');
  log('  EAL_TOKEN_PATH                    same as --token-path');
  log('  NODE_TLS_REJECT_UNAUTHORIZED=0    accept self-signed dev certs');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { command, global } = splitArgs(argv);

  if (global.help && command === undefined) {
    printHelp();
    return 0;
  }
  if (command === undefined || command === 'help') {
    printHelp();
    return command === undefined ? 1 : 0;
  }

  const spec = COMMANDS[command];
  if (!spec) {
    logError(`${BIN_NAME}: unknown command "${command}"`);
    printHelp();
    return 1;
  }
  return spec.handler(global);
}

process.exit(await main());
