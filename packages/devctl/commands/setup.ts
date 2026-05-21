import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sslCmd } from './ssl.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const CERT_PATH = resolve(ROOT, 'packages/api/certs/cert.pem');
const KEY_PATH = resolve(ROOT, 'packages/api/certs/key.pem');
const ENV_PATH = resolve(ROOT, '.env');

/**
 * The values `devctl setup` writes into a fresh `.env`. These are NOT runtime
 * fallbacks — the server has none and refuses to boot without each var. They
 * are concrete values materialised into explicit, user-owned config; edit
 * `.env` to change them. Bun auto-loads `.env` from the project root.
 *
 *   PORT          internal listen port
 *   DATABASE_PATH file-backed SQLite so dev data survives restarts
 *   EAL_ORIGIN    public origin; the WebAuthn RP ID is its hostname
 */
const DEV_ENV: ReadonlyArray<readonly [key: string, value: string]> = [
  ['PORT', '4321'],
  ['DATABASE_PATH', './data/eal.db'],
  ['EAL_ORIGIN', 'https://localhost:4321'],
];

function missingEnvKeys(): string[] {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  return DEV_ENV.filter(([key]) => !new RegExp(`^${key}=`, 'm').test(existing)).map(([k]) => k);
}

function ensureEnv(): Promise<number> {
  if (!existsSync(ENV_PATH)) {
    const body =
      '# eal local dev config — created by `bun devctl setup`, safe to edit.\n' +
      '# Bun auto-loads this file from the project root.\n' +
      DEV_ENV.map(([k, v]) => `${k}=${v}`).join('\n') +
      '\n';
    writeFileSync(ENV_PATH, body, { encoding: 'utf8' });
    console.log(`         wrote .env (${DEV_ENV.map(([k]) => k).join(', ')})`);
    return Promise.resolve(0);
  }
  // .env exists — append only the keys it's missing, never clobber.
  const existing = readFileSync(ENV_PATH, 'utf8');
  const missing = DEV_ENV.filter(([key]) => !new RegExp(`^${key}=`, 'm').test(existing));
  let prefix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
  for (const [key, value] of missing) {
    appendFileSync(ENV_PATH, `${prefix}${key}=${value}\n`, { encoding: 'utf8' });
    prefix = '';
    console.log(`         appended ${key}=${value} to existing .env`);
  }
  return Promise.resolve(0);
}

function checkLitestream(): Promise<number> {
  // Litestream is a soft dependency: plain `devctl dev` doesn't need it, only
  // the local replication mirror and production do. Warn, don't fail setup.
  console.log('         litestream not found on PATH.');
  console.log('         Install it for local replication + the restore test:');
  console.log('           macOS:  brew install litestream');
  console.log('           other:  https://litestream.io/install/');
  return Promise.resolve(0);
}

interface Step {
  id: string;
  name: string;
  isDone: () => boolean | Promise<boolean>;
  run: (args: string[]) => Promise<number>;
}

const STEPS: Step[] = [
  {
    id: 'ssl',
    name: 'TLS certificates',
    isDone: () => existsSync(CERT_PATH) && existsSync(KEY_PATH),
    run: (args) => sslCmd(args),
  },
  {
    id: 'env',
    name: '.env (PORT, DATABASE_PATH, EAL_ORIGIN)',
    isDone: () => missingEnvKeys().length === 0,
    run: () => ensureEnv(),
  },
  {
    id: 'litestream',
    name: 'litestream binary',
    isDone: () => Bun.which('litestream') !== null,
    run: () => checkLitestream(),
  },
];

export async function setupCmd(args: string[]): Promise<number> {
  const only = ((): string | null => {
    const i = args.indexOf('--only');
    if (i === -1 || i + 1 >= args.length) return null;
    return args[i + 1] ?? null;
  })();

  console.log('devctl setup: first-time bring-up');

  for (const step of STEPS) {
    if (only && step.id !== only) continue;
    const done = await step.isDone();
    if (done) {
      console.log(`  [skip] ${step.name} (already configured)`);
      continue;
    }
    console.log(`  [run ] ${step.name}`);
    const code = await step.run([]);
    if (code !== 0) {
      console.error(`devctl setup: step "${step.id}" failed (exit ${code}).`);
      console.error(`  Re-run with: bun devctl setup --only ${step.id}`);
      return code;
    }
  }

  console.log('devctl setup: ok');
  return 0;
}
