import { spawn } from 'bun';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const HOME = homedir();

/**
 * Default paths the brew-bundle + pipx recipe drops on a Mac. The user
 * overrides any of these via env or by exporting the corresponding
 * EAL_* var before invoking — caller-supplied env wins.
 */
const DEFAULT_ENV: Record<string, string> = {
  EAL_STT_PROVIDER: 'whisper-local',
  EAL_WHISPER_BIN: '/opt/homebrew/bin/whisper-cli',
  EAL_WHISPER_MODEL: resolve(HOME, '.eal/models/ggml-base.en.bin'),
  EAL_TTS_PROVIDER: 'piper',
  EAL_PIPER_BIN: resolve(HOME, '.local/bin/piper'),
  EAL_PIPER_MODEL: resolve(HOME, '.eal/models/en_US-amy-medium.onnx'),
};

const DEFAULT_API_URL = 'https://eal.fly.dev';

const HELP = `devctl agent — run the eal agent worker with local voice providers

Usage: bun devctl agent [--api-url=<url>] [extra args passed to eal agent…]

  --api-url=<url>   Defaults to $EAL_API_URL or ${DEFAULT_API_URL}.
  --help            Print this help and exit.

Defaults assume the brew-bundle + pipx setup (whisper-cpp + piper-tts)
with models under ~/.eal/models. Override any of:

  EAL_STT_PROVIDER      ${DEFAULT_ENV['EAL_STT_PROVIDER']}
  EAL_WHISPER_BIN       ${DEFAULT_ENV['EAL_WHISPER_BIN']}
  EAL_WHISPER_MODEL     ${DEFAULT_ENV['EAL_WHISPER_MODEL']}
  EAL_TTS_PROVIDER      ${DEFAULT_ENV['EAL_TTS_PROVIDER']}
  EAL_PIPER_BIN         ${DEFAULT_ENV['EAL_PIPER_BIN']}
  EAL_PIPER_MODEL       ${DEFAULT_ENV['EAL_PIPER_MODEL']}

Example: swap piper for the macOS native say(1):

  EAL_TTS_PROVIDER=say bun devctl agent
`;

function pickApiUrl(args: string[]): { apiUrl: string; rest: string[] } {
  const flag = args.find((a) => a.startsWith('--api-url='));
  if (flag !== undefined) {
    return {
      apiUrl: flag.slice('--api-url='.length),
      rest: args.filter((a) => a !== flag),
    };
  }
  const fromEnv = process.env['EAL_API_URL'];
  return { apiUrl: fromEnv ?? DEFAULT_API_URL, rest: args };
}

/**
 * Fail fast when a referenced model or binary is missing. The worker
 * would otherwise reach for the file mid-call and surface a generic
 * spawn-ENOENT — the operator wants to know the misconfiguration before
 * the first ring.
 */
function preflightPaths(env: Record<string, string>): string[] {
  const missing: string[] = [];
  const check = (label: string, path: string | undefined): void => {
    if (path !== undefined && !existsSync(path)) missing.push(`${label}: ${path}`);
  };
  if (env['EAL_STT_PROVIDER'] === 'whisper-local') {
    check('whisper binary', env['EAL_WHISPER_BIN']);
    check('whisper model', env['EAL_WHISPER_MODEL']);
  }
  if (env['EAL_TTS_PROVIDER'] === 'piper') {
    check('piper binary', env['EAL_PIPER_BIN']);
    check('piper model', env['EAL_PIPER_MODEL']);
  }
  return missing;
}

export async function agentCmd(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const { apiUrl, rest } = pickApiUrl(args);

  const env: Record<string, string> = { ...DEFAULT_ENV };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Prepend ~/.local/bin (pipx's default destination) so callers don't
  // need to have run `pipx ensurepath` in this shell.
  env['PATH'] = `${resolve(HOME, '.local/bin')}:${env['PATH'] ?? ''}`;

  const missing = preflightPaths(env);
  if (missing.length > 0) {
    for (const m of missing) console.error(`devctl agent: missing ${m}`);
    console.error('devctl agent: run `brew bundle && pipx install piper-tts`,');
    console.error('  and download the models per docs/family-phone.md.');
    return 1;
  }

  console.log(`devctl agent: launching against ${apiUrl}`);
  console.log(`  STT: ${env['EAL_STT_PROVIDER']} (${env['EAL_WHISPER_BIN']})`);
  console.log(`  TTS: ${env['EAL_TTS_PROVIDER']} (${env['EAL_PIPER_BIN']})`);

  const proc = spawn(
    ['bun', 'packages/cli/src/index.ts', `--api-url=${apiUrl}`, 'agent', ...rest],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit', env },
  );
  return await proc.exited;
}
