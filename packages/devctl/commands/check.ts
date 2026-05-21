import { spawn } from 'bun';
import { resolve } from 'node:path';

interface CheckResult {
  name: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

const ROOT = resolve(import.meta.dir, '../../..');

const CHECKS: { name: string; cmd: string[] }[] = [
  { name: 'tsc --noEmit', cmd: ['bunx', 'tsc', '--noEmit'] },
  { name: 'check-no-as-casting', cmd: ['bun', 'scripts/check-no-as-casting.ts'] },
  { name: 'check-no-banned-tokens', cmd: ['bun', 'scripts/check-no-banned-tokens.ts'] },
  { name: 'check-no-fixed-waits', cmd: ['bun', 'scripts/check-no-fixed-waits.ts'] },
  { name: 'check-package-boundaries', cmd: ['bun', 'scripts/check-package-boundaries.ts'] },
  { name: 'check-no-tsconfig-paths', cmd: ['bun', 'scripts/check-no-tsconfig-paths.ts'] },
  { name: 'check-no-server-imports', cmd: ['bun', 'scripts/check-no-server-imports.ts'] },
  { name: 'check-no-test-app-in-prod', cmd: ['bun', 'scripts/check-no-test-app-in-prod.ts'] },
];

async function runCheck(name: string, cmd: string[]): Promise<CheckResult> {
  const started = Date.now();
  const proc = spawn(cmd, {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return {
    name,
    exitCode,
    durationMs: Date.now() - started,
    output: [stdout, stderr].filter(Boolean).join('\n'),
  };
}

export async function checkCmd(_args: string[]): Promise<number> {
  const results = await Promise.all(CHECKS.map((c) => runCheck(c.name, c.cmd)));

  let failed = 0;
  const nameWidth = Math.max(...CHECKS.map((c) => c.name.length));
  console.log('check results:');
  for (const r of results) {
    const status = r.exitCode === 0 ? 'ok  ' : 'FAIL';
    const ms = `${r.durationMs}ms`.padStart(7);
    console.log(`  [${status}] ${r.name.padEnd(nameWidth)}  ${ms}`);
    if (r.exitCode !== 0) failed += 1;
  }

  if (failed > 0) {
    console.error('');
    console.error(`${failed} check(s) failed. Details:`);
    for (const r of results) {
      if (r.exitCode === 0) continue;
      console.error(`\n--- ${r.name} (exit ${r.exitCode}) ---`);
      console.error(r.output.trim());
    }
    return 1;
  }

  return 0;
}
