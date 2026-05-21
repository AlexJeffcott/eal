import { spawn } from 'bun';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

export async function devCmd(args: string[]): Promise<number> {
  // PORT is required — the server has no default. It normally comes from `.env`
  // (Bun auto-loads it; `devctl setup` writes it). If it's still missing, point
  // the user at setup rather than letting the server throw a raw stack trace.
  if (process.env['PORT'] === undefined || process.env['PORT'] === '') {
    console.error('devctl dev: PORT is not set.');
    console.error('  Run `bun devctl setup` to create a local .env, or set PORT inline:');
    console.error('  PORT=4321 bun devctl dev');
    return 1;
  }

  // `--litestream` runs the production entrypoint (deploy/entrypoint.sh) against
  // a local file replica — the same restore-then-replicate choreography prod
  // uses, so the cold-start path is exercised in dev. Differs from prod only in
  // the replica type (file vs s3).
  if (args.includes('--litestream')) {
    if (Bun.which('litestream') === null) {
      console.error('devctl dev --litestream: the litestream binary is not on PATH.');
      console.error('  Install it (macOS: `brew install litestream`) or run `bun devctl setup`.');
      return 1;
    }
    const proc = spawn(['./deploy/entrypoint.sh'], {
      cwd: ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        LITESTREAM_CONFIG: 'deploy/litestream-dev.yml',
        LITESTREAM_DEV_REPLICA_PATH: resolve(ROOT, 'data/replica'),
      },
    });
    return await proc.exited;
  }

  const watch = args.includes('--watch');
  const cmd = watch
    ? ['bun', '--watch', 'packages/api/src/server.ts']
    : ['bun', 'packages/api/src/server.ts'];
  const proc = spawn(cmd, {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  return await proc.exited;
}
