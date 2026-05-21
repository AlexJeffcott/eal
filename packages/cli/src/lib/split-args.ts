/**
 * Split a raw argv tail into the global options, the subcommand name, and
 * the args destined for the subcommand. Walks argv manually instead of
 * using node:util parseArgs in non-strict mode (which mis-classifies
 * unknown flags as positionals).
 *
 * Global flags recognised here:
 *   --api-url=<url>  / --api-url <url>     ($EAL_API_URL fallback)
 *   --token-path=<path> / --token-path <path>  ($EAL_TOKEN_PATH fallback)
 *   --json
 *   --verbose / -v
 *   --help / -h
 *
 * Anything else is forwarded verbatim. The first non-flag token is the
 * subcommand name; the rest is the subcommand's argv.
 */
import { DEFAULT_API_URL } from './runtime.ts';
import type { GlobalOptions } from '../types.ts';

const GLOBAL_BOOLEAN_FLAGS = new Set(['--json', '--verbose', '-v', '--help', '-h']);
const GLOBAL_VALUE_FLAGS = new Set(['--api-url', '--token-path']);

export interface SplitResult {
  command: string | undefined;
  global: GlobalOptions;
}

export function splitArgs(argv: readonly string[]): SplitResult {
  const apiUrlEnv = process.env['EAL_API_URL'];
  const tokenPathEnv = process.env['EAL_TOKEN_PATH'];

  const global: GlobalOptions = {
    apiUrl: apiUrlEnv && apiUrlEnv.length > 0 ? apiUrlEnv : DEFAULT_API_URL,
    tokenPathOverride: tokenPathEnv && tokenPathEnv.length > 0 ? tokenPathEnv : undefined,
    json: false,
    verbose: false,
    help: false,
    commandArgs: [],
  };

  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;

    if (a.startsWith('--api-url=')) {
      global.apiUrl = a.slice('--api-url='.length);
      continue;
    }
    if (a.startsWith('--token-path=')) {
      global.tokenPathOverride = a.slice('--token-path='.length);
      continue;
    }

    if (GLOBAL_BOOLEAN_FLAGS.has(a)) {
      if (a === '--json') global.json = true;
      else if (a === '--verbose' || a === '-v') global.verbose = true;
      else if (a === '--help' || a === '-h') global.help = true;
      continue;
    }

    if (GLOBAL_VALUE_FLAGS.has(a)) {
      const next = argv[i + 1];
      if (next !== undefined) {
        if (a === '--api-url') global.apiUrl = next;
        else if (a === '--token-path') global.tokenPathOverride = next;
        i += 1;
      }
      continue;
    }

    if (command === undefined) {
      command = a;
    } else {
      global.commandArgs.push(a);
    }
  }

  return { command, global };
}

/** Helper for subcommands: read a string flag from `commandArgs`. */
export function readStringFlag(args: readonly string[], name: string): string | undefined {
  const long = `--${name}`;
  const longEq = `${long}=`;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith(longEq)) return a.slice(longEq.length);
    if (a === long) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) return next;
    }
  }
  return undefined;
}
