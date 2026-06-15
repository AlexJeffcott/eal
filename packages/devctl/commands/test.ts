import { spawn } from 'bun';
import { resolve } from 'node:path';
import {
  type CoverageFindings,
  evaluateCoverage,
  hasFailure,
  parseCoverageTable,
} from '@fairfox/polly/test/coverage';
import { APPS, appById } from '../apps.config.ts';
import { config as coverageConfig } from '../../../scripts/coverage.config.ts';

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
  const code = await proc.exited;
  if (code !== 0) return code;

  // The bun runner emits reports/mutation/mutation.json (json reporter). Read
  // the kill matrix backwards via Polly's shipped analysis: gaps (NoCoverage),
  // theatre (Survived), and — when the patched runner records every killer —
  // redundant/subsumed tests. Advisory: a clean run still exits 0.
  const report = spawn(['bunx', 'polly', 'mutate', 'report'], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await report.exited;
  return 0;
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
  // files — so when an app declares any browser files we run the whole tier
  // (a superset). When `browser: []`, skip it: the tier was just verified by
  // another app's run, and re-running it pointlessly hits polly#159 (the
  // browser runner intermittently deadlocks at chat.browser.tsx).
  if (app.browser.length > 0) {
    console.log(`\n=== ${app.id}: browser (full tier; app files: ${app.browser.join(', ')}) ===`);
    // Spawn with cwd at the package that owns the tests — from the monorepo
    // root the runner deadlocks more reliably (polly#159, workaround).
    const browser = spawn(['bunx', 'polly', 'test:browser', 'tests/browser'], {
      cwd: resolve(ROOT, 'packages/web'),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const browserCode = await browser.exited;
    if (browserCode !== 0) return browserCode;
  } else {
    console.log(`\n=== ${app.id}: browser — skipped (app declares no browser files) ===`);
  }

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

  // Apply the per-file coverage policy in-process via Polly's shipped engine
  // (@fairfox/polly/test/coverage) against scripts/coverage.config.ts. Bun
  // prints the coverage table to stderr; parse the combined output so it
  // doesn't matter which stream it lands on. Orphan detection is deliberately
  // not surfaced — with `srcDir: 'packages'` it spans tooling, browser-only and
  // e2e-only packages and isn't a meaningful unit-tier gate here.
  const srcDir = coverageConfig.srcDir ?? 'src';
  const rows = parseCoverageTable(`${stdoutText}\n${stderrText}`, srcDir);
  if (rows.length === 0) {
    console.error('coverage: no rows parsed from the `bun test --coverage` table.');
    return 1;
  }
  const findings = await evaluateCoverage(ROOT, rows, coverageConfig);
  reportCoverage(findings);
  return hasFailure(findings, false) ? 1 : 0;
}

/** Print the coverage-policy failures (orphans stay advisory, see runUnit). */
function reportCoverage(f: CoverageFindings): void {
  for (const m of f.missingExemptFiles) {
    console.error(`coverage: exempt source missing: ${m}`);
  }
  for (const { file, claimedBy } of f.missingClaimedBy) {
    console.error(`coverage: ${file} → claimedBy missing: ${claimedBy}`);
  }
  for (const s of f.staleExempts) {
    console.error(
      `coverage: exempt file now meets the floor — promote it (remove from coverage.config.ts): ${s}`,
    );
  }
  for (const v of f.violations) {
    console.error(`coverage: ${v.file} ${v.metric}=${v.observed.toFixed(2)}% (need ≥ ${v.required}%)`);
  }
  if (!hasFailure(f, false)) {
    const exemptCount = Object.keys(coverageConfig.exempt ?? {}).length;
    console.log(`coverage: ok (${f.rowCount} files, ${exemptCount} exempt)`);
  }
}

async function runBrowser(): Promise<number> {
  // See `runApp` — polly#159, the runner deadlocks from the monorepo root.
  const proc = spawn(['bunx', 'polly', 'test:browser', 'tests/browser'], {
    cwd: resolve(ROOT, 'packages/web'),
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
