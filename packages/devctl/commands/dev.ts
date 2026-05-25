import { spawn } from 'bun';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

/**
 * True if `port` is already bound. A bind attempt that throws is the signal;
 * a successful bind is released immediately.
 *
 * This is the guard against stale dev servers. `devctl dev` spawns the server
 * as a child process; an interactive Ctrl-C reaps both (they share the
 * terminal's foreground process group), but a single-target `kill <pid>` or
 * `pkill -f "devctl dev"` reaps only the wrapper and orphans the child on the
 * port. Signal-forwarding from the wrapper would be the natural fix, but Bun
 * (1.3.x) does not deliver SIGTERM to a JS `process.on` handler, so it cannot
 * be done reliably. Instead we fail the *next* `devctl dev` fast, so a stale
 * server is caught immediately and never silently shadowed by a new one.
 */
function portInUse(port: number): boolean {
  try {
    const probe = Bun.listen({ hostname: '0.0.0.0', port, socket: { data() {} } });
    probe.stop(true);
    return false;
  } catch {
    return true;
  }
}

export async function devCmd(args: string[]): Promise<number> {
  // PORT is required — the server has no default. It normally comes from `.env`
  // (Bun auto-loads it; `devctl setup` writes it). If it's still missing, point
  // the user at setup rather than letting the server throw a raw stack trace.
  const port = process.env['PORT'];
  if (port === undefined || port === '') {
    console.error('devctl dev: PORT is not set.');
    console.error('  Run `bun devctl setup` to create a local .env, or set PORT inline:');
    console.error('  PORT=4321 bun devctl dev');
    return 1;
  }

  // Fail fast if the port is taken. Without this, a second `devctl dev` stacks
  // a doomed server behind the running one — and the stale one keeps answering,
  // serving an out-of-date bundle that looks like a mystifying bug.
  if (portInUse(Number(port))) {
    console.error(`devctl dev: port ${port} is already in use — a dev server is likely`);
    console.error('  still running (possibly orphaned). Stop it first:');
    console.error(`    lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill`);
    console.error('  or run with a different PORT.');
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
