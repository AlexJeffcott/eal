import { spawn, which } from 'bun';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

const EXIT_DOCKER_MISSING = 2;

async function dockerRunning(): Promise<boolean> {
  if (!which('docker')) return false;
  const proc = spawn(['docker', 'info'], { stdout: 'pipe', stderr: 'pipe' });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const code = await proc.exited;
  return code === 0;
}

export async function verifyCmd(args: string[]): Promise<number> {
  if (!(await dockerRunning())) {
    console.error('devctl verify: Docker is required for TLC model-checking.');
    console.error('  Install Docker Desktop, start it, and rerun.');
    console.error('  https://www.docker.com/products/docker-desktop');
    return EXIT_DOCKER_MISSING;
  }

  const proc = spawn(['bunx', 'polly', 'verify', ...args], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  const pollyExit = await proc.exited;
  if (pollyExit !== 0) return pollyExit;

  // polly lists a `customTLAPaths` spec and skips it ("witnessed, not
  // generated"), so a hand-written spec is checked here or not at all. Flags
  // such as `--witness` are polly's; the hand-written specs run regardless.
  for (const spec of HAND_WRITTEN_SPECS) {
    const failures = await runHandWrittenSpec(spec);
    if (failures.length > 0) {
      console.error(`devctl verify: ${spec.module} FAILED`);
      for (const failure of failures) console.error(`  - ${failure}`);
      return 1;
    }
  }
  return 0;
}

interface HandWrittenSpec {
  /** Directory under specs/tla/ holding `<module>.tla` and `<module>.cfg`. */
  dir: string;
  module: string;
}

/**
 * Specs polly's generator cannot produce: it models enum and number fields
 * behind HTTP handlers, with no sets, no sequences and no second device.
 */
const HAND_WRITTEN_SPECS: readonly HandWrittenSpec[] = [
  { dir: 'tasks-convergence', module: 'TasksConvergence' },
];

/** The image `polly verify` builds on its first run. */
const TLC_IMAGE = 'polly-tla';

/**
 * Run TLC over one hand-written spec and return what is wrong, if anything.
 *
 * The same three readings scripts/verify-tla-exhaustive.ts takes, for the same
 * reason: "No error has been found" is also what a run that went nowhere
 * prints, so completion, an empty queue and a state count above the initial
 * one are each asserted.
 */
async function runHandWrittenSpec(spec: HandWrittenSpec): Promise<string[]> {
  const specDir = resolve(ROOT, 'specs/tla', spec.dir);
  const started = Date.now();
  const tlc = spawn(
    [
      'docker', 'run', '--rm', '--memory=4g',
      '-e', 'JAVA_TOOL_OPTIONS=-Xmx3g -XX:+UseParallelGC',
      '-v', `${specDir}:/work`,
      TLC_IMAGE,
      'tlc', '-workers', '6', '-cleanup', '-metadir', '/tmp/states', `${spec.module}.tla`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const output = (await new Response(tlc.stdout).text()) + (await new Response(tlc.stderr).text());
  await tlc.exited;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const initial = output.match(/Finished computing initial states: (\d+) distinct state/);
  const summary = output.match(
    /(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue/,
  );
  const violated = output.match(/Invariant (\w+) is violated/);
  const distinct = summary?.[2] ? Number.parseInt(summary[2], 10) : 0;
  const queued = summary?.[3] ? Number.parseInt(summary[3], 10) : Number.NaN;
  const initialStates = initial?.[1] ? Number.parseInt(initial[1], 10) : 0;

  const failures: string[] = [];
  if (violated?.[1]) failures.push(`invariant ${violated[1]} is violated`);
  if (!output.includes('Model checking completed. No error has been found.')) {
    failures.push('TLC did not print "Model checking completed. No error has been found."');
  }
  if (!Number.isFinite(queued)) failures.push('TLC printed no summary line');
  else if (queued > 0) failures.push(`${queued} states left on queue — the model was not exhausted`);
  if (distinct <= initialStates) {
    failures.push(`${distinct} distinct states against ${initialStates} initial — no transition fired`);
  }
  if (failures.length === 0) {
    console.log(
      `✓ ${spec.module} (hand-written): ${distinct.toLocaleString()} distinct states, ` +
        `0 left on queue, ${seconds}s`,
    );
  } else {
    console.error(output);
  }
  return failures;
}
