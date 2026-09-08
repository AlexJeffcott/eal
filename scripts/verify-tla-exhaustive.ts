#!/usr/bin/env bun
/**
 * Proof that `polly verify`'s green tick means something.
 *
 * The shape required by ~/projects/CLAUDE.md ("Green checks do not prove
 * features work"). `polly verify` prints a state count per subsystem and a
 * compositional PASS. Both are unreliable today:
 *
 *   - polly#182 — the printed count is TLC's INITIAL-state count, not its
 *     distinct-state count. Every eal subsystem prints "8 states", because 8
 *     is |PayloadType|. A spec whose handlers were all disabled would print
 *     the same 8 and the same tick.
 *   - polly#181 — the TLC container has no memory cap, so a model too large
 *     for the machine is killed rather than failing with a TLC message.
 *   - polly#183 — `--estimate` omits the send branching factor, so it cannot
 *     be used to predict which of those two outcomes you will get.
 *
 * So the tick is not evidence. This script is. It runs TLC over the specs
 * `polly verify` generated and asserts, per subsystem, the three facts that
 * distinguish an exhaustive proof from a run that went nowhere:
 *
 *   1. TLC printed its own completion line ("Model checking completed").
 *   2. `states left on queue` is 0 — nothing was left unexplored.
 *   3. distinct states exceed the initial-state count — the model moved.
 *
 * Run `bun run verify` first: this reads what that generated, and fails if
 * the specs are absent or older than the config that should have produced
 * them. One command, and the answer is a state count or a named failure.
 *
 *   bun scripts/verify-tla-exhaustive.ts
 */
import { spawn } from 'bun';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const GENERATED = resolve(ROOT, 'specs/tla/generated');
const CONFIG = resolve(ROOT, 'specs/verification.config.ts');

/** Must match `subsystems` in specs/verification.config.ts. */
const SUBSYSTEMS = ['tasks', 'pairing', 'auth'] as const;

/**
 * polly#181: polly's own `docker run` sets neither of these, so TLC sizes its
 * heap from the Docker Desktop allocation and a long run is killed by the
 * host. Set them here so this script's result does not depend on a machine
 * setting. `-Xmx` stays below `--memory`: the JVM's offheap fingerprint set
 * and metaspace sit outside the heap and inside the container limit.
 */
const CONTAINER_MEMORY = '8g';
const JVM_OPTIONS = '-Xmx6g -XX:+UseParallelGC';
const TLC_IMAGE = 'polly-tla';
const WORKERS = 6;

interface Reading {
  subsystem: string;
  completed: boolean;
  generatedStates: number;
  distinctStates: number;
  queueRemaining: number;
  initialStates: number;
  depth: number;
  seconds: number;
}

function parse(subsystem: string, output: string, seconds: number): Reading {
  // polly#182 is exactly this: the initial-states line and the summary line
  // both contain "distinct states", and matching the loose pattern returns
  // the initial one. Anchor each on the whole line it belongs to.
  const initial = output.match(/Finished computing initial states: (\d+) distinct states generated/);
  const summary = output.match(
    /(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue/,
  );
  const depth = output.match(/The depth of the complete state graph search is (\d+)/);

  return {
    subsystem,
    completed: output.includes('Model checking completed'),
    generatedStates: summary?.[1] ? Number.parseInt(summary[1], 10) : 0,
    distinctStates: summary?.[2] ? Number.parseInt(summary[2], 10) : 0,
    // No summary line means TLC never reached its own summary. Report that as
    // an unexplored queue rather than as zero, so it cannot read as complete.
    queueRemaining: summary?.[3] ? Number.parseInt(summary[3], 10) : Number.NaN,
    initialStates: initial?.[1] ? Number.parseInt(initial[1], 10) : 0,
    depth: depth?.[1] ? Number.parseInt(depth[1], 10) : 0,
    seconds,
  };
}

async function runTLC(subsystem: string): Promise<Reading> {
  const specDir = resolve(GENERATED, subsystem);
  const spec = `UserApp_${subsystem}.tla`;

  if (!existsSync(resolve(specDir, spec))) {
    throw new Error(
      `${subsystem}: ${spec} not found under specs/tla/generated/.\n` +
        `  Run \`bun run verify\` first — it generates the specs this script checks.`,
    );
  }
  if (statSync(resolve(specDir, spec)).mtimeMs < statSync(CONFIG).mtimeMs) {
    throw new Error(
      `${subsystem}: ${spec} is older than specs/verification.config.ts.\n` +
        `  The spec on disk does not reflect the current config. Rerun \`bun run verify\`.`,
    );
  }

  const started = Date.now();
  const proc = spawn(
    [
      'docker',
      'run',
      '--rm',
      `--memory=${CONTAINER_MEMORY}`,
      '-e',
      `JAVA_TOOL_OPTIONS=${JVM_OPTIONS}`,
      '-v',
      `${specDir}:/work`,
      TLC_IMAGE,
      'tlc',
      '-workers',
      `${WORKERS}`,
      '-cleanup',
      '-metadir',
      '/tmp/states',
      spec,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  return parse(subsystem, stdout + stderr, (Date.now() - started) / 1000);
}

function failuresFor(r: Reading): string[] {
  const failures: string[] = [];
  if (!r.completed) {
    failures.push('TLC did not print "Model checking completed" — the run did not finish');
  }
  if (!Number.isFinite(r.queueRemaining)) {
    failures.push('TLC printed no summary line — killed, or it stopped on an error');
  } else if (r.queueRemaining > 0) {
    failures.push(`${r.queueRemaining} states left on queue — the model was not exhausted`);
  }
  if (r.distinctStates <= r.initialStates) {
    failures.push(
      `${r.distinctStates} distinct states against ${r.initialStates} initial — ` +
        'no transition fired, so the invariants held over nothing',
    );
  }
  return failures;
}

async function main(): Promise<number> {
  console.log('Running TLC over the generated subsystem specs.\n');

  const readings: Reading[] = [];
  for (const subsystem of SUBSYSTEMS) {
    readings.push(await runTLC(subsystem));
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number) => (Number.isFinite(n) ? n.toLocaleString() : '—');
  console.log(
    `${pad('subsystem', 12)}${pad('distinct', 12)}${pad('generated', 12)}` +
      `${pad('queue', 8)}${pad('depth', 7)}time`,
  );
  for (const r of readings) {
    console.log(
      `${pad(r.subsystem, 12)}${pad(num(r.distinctStates), 12)}${pad(num(r.generatedStates), 12)}` +
        `${pad(num(r.queueRemaining), 8)}${pad(String(r.depth), 7)}${r.seconds.toFixed(1)}s`,
    );
  }
  console.log();

  let failed = false;
  for (const r of readings) {
    const failures = failuresFor(r);
    if (failures.length === 0) {
      console.log(
        `✓ ${r.subsystem}: exhaustive — ${r.distinctStates.toLocaleString()} distinct states, ` +
          `queue empty, depth ${r.depth}`,
      );
      continue;
    }
    failed = true;
    console.log(`✗ ${r.subsystem}:`);
    for (const f of failures) console.log(`    ${f}`);
  }

  console.log();
  if (failed) {
    console.log('FAILED — at least one subsystem was not exhaustively checked.');
    return 1;
  }
  console.log('PASS — every subsystem was explored to an empty queue.');
  return 0;
}

process.exit(await main());
