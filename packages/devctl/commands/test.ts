import { spawn } from 'bun';
import { resolve } from 'node:path';
import { APPS, appById } from '../apps.config.ts';

const ROOT = resolve(import.meta.dir, '../../..');

type Tier = 'unit' | 'browser' | 'e2e' | 'multi' | 'mutation' | 'all';

const TIERS: Tier[] = ['unit', 'browser', 'e2e', 'multi'];

function isTier(value: string): value is Tier {
  return (
    value === 'unit' ||
    value === 'browser' ||
    value === 'e2e' ||
    value === 'multi' ||
    value === 'mutation' ||
    value === 'all'
  );
}

async function runMutation(): Promise<number> {
  // Stryker's mutate list is composed: the global/shell files in
  // stryker.conf.json plus every app's declared `mutate` files
  // (apps.config.ts). Each file is listed once — apps own their targets,
  // stryker.conf.json owns the rest — and `--mutate` overrides the config.
  const conf = await Bun.file(resolve(ROOT, 'stryker.conf.json')).json();
  const globalMutate: string[] = Array.isArray(conf.mutate) ? conf.mutate : [];
  const mutate = [...globalMutate, ...APPS.flatMap((app) => app.mutate)];
  // Fail loud on a stale entry — Stryker silently skips a mutate path that no
  // longer exists, which would quietly shrink mutation coverage.
  const missing: string[] = [];
  for (const file of mutate) {
    if (!(await Bun.file(resolve(ROOT, file)).exists())) missing.push(file);
  }
  if (missing.length > 0) {
    console.error('devctl test mutation: these mutate targets do not exist:');
    for (const file of missing) console.error(`  ${file}`);
    return 1;
  }
  const proc = spawn(['bunx', 'stryker', 'run', '--mutate', mutate.join(',')], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

/** Run one app's full verification surface (see apps.config.ts). */
async function runApp(appId: string): Promise<number> {
  const app = appById(appId);
  if (!app) {
    console.error(`devctl test --app: unknown app "${appId}"`);
    console.error(`Known apps: ${APPS.map((a) => a.id).join(', ')}`);
    return 1;
  }

  console.log(`\n=== ${app.id}: unit ===`);
  const unit = spawn(['bun', 'test', ...app.unit], {
    cwd: ROOT,
    env: { ...process.env, SKIP_TLS: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const unitCode = await unit.exited;
  if (unitCode !== 0) return unitCode;

  // Polly's browser runner is directory-scoped — it cannot take individual
  // files — so this runs the whole browser tier (a superset of the app's
  // browser files, named here for the record).
  console.log(`\n=== ${app.id}: browser (full tier; app files: ${app.browser.join(', ')}) ===`);
  const browser = spawn(['bunx', 'polly', 'test:browser', 'packages/web/tests/browser'], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const browserCode = await browser.exited;
  if (browserCode !== 0) return browserCode;

  console.log(`\n=== ${app.id}: e2e ===`);
  const e2e = spawn(['bunx', 'playwright', 'test', ...app.e2e], {
    cwd: resolve(ROOT, 'packages/e2e-tests'),
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await e2e.exited;
}

async function runUnit(): Promise<number> {
  // Capture stderr so we can pipe the coverage table to the enforcer;
  // still print it through to the user so the table is visible.
  const proc = spawn(
    [
      'bun',
      'test',
      '--coverage',
      '--path-ignore-patterns=**/e2e-tests/**',
      '--path-ignore-patterns=**/tests/browser/**',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, SKIP_TLS: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  process.stdout.write(stdoutText);
  process.stderr.write(stderrText);

  const testExit = await proc.exited;
  if (testExit !== 0) return testExit;

  const enforcer = spawn(['bun', 'scripts/enforce-coverage.ts'], {
    cwd: ROOT,
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  enforcer.stdin.write(stderrText);
  await enforcer.stdin.end();
  return await enforcer.exited;
}

async function runBrowser(): Promise<number> {
  const proc = spawn(['bunx', 'polly', 'test:browser', 'packages/web/tests/browser'], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

async function runE2E(): Promise<number> {
  const proc = spawn(['bunx', 'playwright', 'test'], {
    cwd: resolve(ROOT, 'packages/e2e-tests'),
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });
  return await proc.exited;
}

async function runMulti(): Promise<number> {
  const glob = new Bun.Glob('scripts/e2e-*.ts');
  const scripts: string[] = [];
  for await (const path of glob.scan({ cwd: ROOT })) {
    scripts.push(path);
  }
  if (scripts.length === 0) {
    console.error('devctl test multi: no scripts/e2e-*.ts files found');
    return 1;
  }
  scripts.sort();
  for (const script of scripts) {
    console.log(`\n=== ${script} ===`);
    const proc = spawn(['bun', script], {
      cwd: ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await proc.exited;
    if (code !== 0) return code;
  }
  return 0;
}

async function runAll(): Promise<number> {
  for (const tier of TIERS) {
    console.log(`\n=== test ${tier} ===`);
    const code = await runTier(tier);
    if (code !== 0) return code;
  }
  return 0;
}

async function runTier(tier: Tier): Promise<number> {
  switch (tier) {
    case 'unit':
      return runUnit();
    case 'browser':
      return runBrowser();
    case 'e2e':
      return runE2E();
    case 'multi':
      return runMulti();
    case 'mutation':
      return runMutation();
    case 'all':
      return runAll();
  }
}

export async function testCmd(args: string[]): Promise<number> {
  const [first, second] = args;
  if (!first || first === '--help' || first === '-h') {
    console.log('Usage: bun devctl test <unit|browser|e2e|multi|mutation|all>');
    console.log('       bun devctl test --app <id>');
    return first ? 0 : 1;
  }
  if (first === '--app') {
    if (!second) {
      console.error('devctl test --app: an app id is required');
      console.error(`Known apps: ${APPS.map((a) => a.id).join(', ')}`);
      return 1;
    }
    return runApp(second);
  }
  if (!isTier(first)) {
    console.error(`devctl test: unknown tier "${first}"`);
    console.error('Usage: bun devctl test <unit|browser|e2e|multi|mutation|all>');
    console.error('       bun devctl test --app <id>');
    return 1;
  }
  return runTier(first);
}
