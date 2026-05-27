import { agentCmd } from './commands/agent.ts';
import { checkCmd } from './commands/check.ts';
import { devCmd } from './commands/dev.ts';
import { installHooksCmd } from './commands/install-hooks.ts';
import { setupCmd } from './commands/setup.ts';
import { sslCmd } from './commands/ssl.ts';
import { testCmd } from './commands/test.ts';
import { verifyCmd } from './commands/verify.ts';
import { visualizeCmd } from './commands/visualize.ts';

type CommandHandler = (args: string[]) => Promise<number> | number;

interface Command {
  description: string;
  handler: CommandHandler;
}

const COMMANDS: Record<string, Command> = {
  agent: {
    description: 'Run `eal agent` against the deployed app with local voice providers pre-wired',
    handler: agentCmd,
  },
  check: {
    description: 'Run all quality checks (tsc, lint scripts) in parallel',
    handler: checkCmd,
  },
  dev: {
    description: 'Boot the single api + SPA server (HTTPS via packages/api/certs)',
    handler: devCmd,
  },
  'install-hooks': {
    description: 'Install .git/hooks/pre-commit (fast) and pre-push (full sweep)',
    handler: installHooksCmd,
  },
  setup: {
    description: 'Idempotent first-time setup (generates TLS certs if missing)',
    handler: setupCmd,
  },
  ssl: {
    description: 'Generate local TLS certs into packages/api/certs/ (mkcert, openssl fallback)',
    handler: sslCmd,
  },
  test: {
    description: 'Run tests: unit | browser | e2e | multi | mutation | all, or --app <id>',
    handler: testCmd,
  },
  verify: {
    description: 'Run polly TLC model-checking (requires Docker; exits 2 if missing)',
    handler: verifyCmd,
  },
  visualize: {
    description: 'Generate Structurizr architecture DSL via polly visualize',
    handler: visualizeCmd,
  },
};

function printHelp(): number {
  const lines: string[] = [
    'devctl — eal development CLI',
    '',
    'Usage: bun devctl <command> [...args]',
    '',
    'Commands:',
  ];
  const names = Object.keys(COMMANDS).sort();
  if (names.length === 0) {
    lines.push('  (no commands registered yet)');
  } else {
    const width = Math.max(...names.map((n) => n.length));
    for (const name of names) {
      const cmd = COMMANDS[name];
      if (!cmd) continue;
      lines.push(`  ${name.padEnd(width)}  ${cmd.description}`);
    }
  }
  lines.push('', 'Use "bun devctl <command> --help" for command-specific help.');
  console.log(lines.join('\n'));
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    return printHelp();
  }

  const [name, ...rest] = argv;
  if (!name) return printHelp();

  const command = COMMANDS[name];
  if (!command) {
    console.error(`devctl: unknown command "${name}"`);
    console.error('Run "bun devctl --help" to see available commands.');
    return 1;
  }

  return await command.handler(rest);
}

process.exit(await main());
