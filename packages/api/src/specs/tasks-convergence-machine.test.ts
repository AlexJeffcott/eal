import { describe, expect, test } from 'bun:test';
import {
  capture,
  deleteTask,
  deliver,
  drop,
  explore,
  flushAcked,
  flushLost,
  initialState,
  NO_FAULTS,
  seed,
  type ConvergenceModel,
  type Faults,
} from './tasks-convergence-machine.ts';

/**
 * The model in tasks-convergence-machine.ts, explored exhaustively. See that
 * file's banner: the TLA+ twin is checked by TLC in `bun devctl verify`, and
 * the state count asserted here is the one TLC prints for the same constants
 * (specs/tla/tasks-convergence/TasksConvergence.cfg). If the two drift, this
 * number stops matching.
 */
const MODEL: ConvergenceModel = { devices: ['d1', 'd2'], clientIds: ['c1', 'c2'], maxQueue: 3 };

/** TLC: "32931 states generated, 5991 distinct states found, 0 states left on queue". */
const TLC_DISTINCT_STATES = 5991;

describe('tasks-convergence-machine — every reachable state', () => {
  test('all six invariants hold, over the state space TLC counts', () => {
    const result = explore(MODEL);
    expect(result.violated).toBeNull();
    expect(result.distinctStates).toBe(TLC_DISTINCT_STATES);
  });
});

/**
 * A safety property nothing can violate proves nothing. Each fault breaks the
 * model one way; the invariant it should cost must be the one reported.
 */
describe('tasks-convergence-machine — each invariant can fail', () => {
  const cases: ReadonlyArray<[keyof Faults, string]> = [
    ['noDedupe', 'AtMostOneRowPerClientId'],
    ['phantomCapture', 'NoPhantomTasks'],
    ['deliverKeepsEntry', 'NoDoubleDisplay'],
    ['seedKeepsEntry', 'NoDoubleDisplay'],
    ['volatileOutbox', 'NoLostCapture'],
    ['silentDelete', 'Converged'],
  ];
  for (const [fault, invariant] of cases) {
    test(`${fault} violates ${invariant}`, () => {
      expect(explore(MODEL, { ...NO_FAULTS, [fault]: true }).violated).toBe(invariant);
    });
  }

  test('silentDelete violates NoLostDeletes when Converged is not there to fail first', async () => {
    const { INVARIANTS } = await import('./tasks-convergence-machine.ts');
    const withoutConverged = INVARIANTS.filter((i) => i.name !== 'Converged');
    const result = explore(MODEL, { ...NO_FAULTS, silentDelete: true }, withoutConverged);
    expect(result.violated).toBe('NoLostDeletes');
  });
});

describe('tasks-convergence-machine — the paths the outbox exists for', () => {
  test('a lost response, then a retry: one row, and the entry settles', () => {
    let s = initialState(MODEL);
    s = capture(s, 'd1', 'c1') ?? s;
    expect(s.outbox['d1']).toEqual(['c1']);

    s = flushLost(s, 'd1', 'c1') ?? s;
    expect(s.serverCount['c1']).toBe(1);
    expect(s.outbox['d1']).toEqual(['c1']);

    s = flushAcked(s, 'd1', 'c1') ?? s;
    expect(s.serverCount['c1']).toBe(1);
    expect(s.outbox['d1']).toEqual([]);
    expect(s.rows['d1']?.['c1']).toBe('live');
  });

  test('a lost response settles by broadcast when the socket is up', () => {
    let s = initialState(MODEL);
    s = seed(s, 'd1') ?? s;
    s = capture(s, 'd1', 'c1') ?? s;
    s = flushLost(s, 'd1', 'c1') ?? s;
    expect(s.queue['d1']).toEqual([{ cid: 'c1', kind: 'created' }]);

    s = deliver(s, 'd1') ?? s;
    expect(s.outbox['d1']).toEqual([]);
    expect(s.rows['d1']?.['c1']).toBe('live');
  });

  test('a lost response settles by seed when the socket was down', () => {
    let s = initialState(MODEL);
    s = capture(s, 'd1', 'c1') ?? s;
    s = flushLost(s, 'd1', 'c1') ?? s;
    s = seed(s, 'd1') ?? s;
    expect(s.outbox['d1']).toEqual([]);
    expect(s.rows['d1']?.['c1']).toBe('live');
  });

  test('the outbox survives a dropped session; the broadcasts do not', () => {
    let s = initialState(MODEL);
    s = seed(s, 'd1') ?? s;
    s = seed(s, 'd2') ?? s;
    s = capture(s, 'd1', 'c1') ?? s;
    s = capture(s, 'd2', 'c2') ?? s;
    s = flushAcked(s, 'd2', 'c2') ?? s;
    expect(s.queue['d1']?.length).toBe(1);

    s = drop(s, 'd1') ?? s;
    expect(s.queue['d1']).toEqual([]);
    expect(s.outbox['d1']).toEqual(['c1']);
  });

  test('a client id is minted once', () => {
    const s = capture(initialState(MODEL), 'd1', 'c1');
    expect(s).not.toBeNull();
    if (s === null) return;
    expect(capture(s, 'd2', 'c1')).toBeNull();
  });

  test('a pending entry cannot be deleted; a confirmed row can, and peers hear it', () => {
    let s = initialState(MODEL);
    s = seed(s, 'd2') ?? s;
    s = capture(s, 'd1', 'c1') ?? s;
    expect(deleteTask(s, 'd1', 'c1')).toBeNull();

    s = flushAcked(s, 'd1', 'c1') ?? s;
    s = deleteTask(s, 'd1', 'c1') ?? s;
    expect(s.serverDeleted['c1']).toBe(true);
    expect(s.queue['d2']).toEqual([
      { cid: 'c1', kind: 'created' },
      { cid: 'c1', kind: 'deleted' },
    ]);
  });

  test('guards: nothing to flush, nothing to deliver, nothing to drop, already seeded', () => {
    const s = initialState(MODEL);
    expect(flushAcked(s, 'd1', 'c1')).toBeNull();
    expect(flushLost(s, 'd1', 'c1')).toBeNull();
    expect(deliver(s, 'd1')).toBeNull();
    expect(drop(s, 'd1')).toBeNull();
    const seeded = seed(s, 'd1');
    expect(seeded).not.toBeNull();
    if (seeded === null) return;
    expect(seed(seeded, 'd1')).toBeNull();
  });
});
