/**
 * Multi-device task convergence with a capture outbox — the spec
 * docs/tasks-v1.md promised and tasks-status-machine.ts deferred, written for
 * Plan 06 part B (docs/plans/06-offline-capture.md).
 *
 * Unlike its siblings this is not a `$sharedState` shadow anchored to route
 * handlers. polly's generator models enum and number fields behind HTTP
 * handlers; it has no sets, no sequences and no second device, and this model
 * is nothing but those. So there are two twins, and they change together:
 *
 *   - specs/tla/tasks-convergence/TasksConvergence.tla — hand-written TLA+,
 *     checked by TLC at the end of `bun devctl verify`.
 *   - this file — the same actions and invariants as a pure TypeScript model,
 *     explored exhaustively by its unit test. The test asserts the same
 *     distinct-state count TLC reports, which is what keeps the twins honest,
 *     and then breaks the model once per invariant (`Faults`) so every
 *     invariant is shown able to fail. A safety property nothing can violate
 *     proves nothing.
 *
 * A task is known only by the client id it was captured under. The server is a
 * COUNT of rows per client id, not a flag: a flag could not hold two rows, and
 * the idempotency invariant would be true by construction.
 *
 *   capture ──► outbox entry ──flush──► server row ──► broadcast ──► peers
 *                   ▲    │                  │
 *                   │    └── response lost ─┤  (entry stays, flushed again)
 *          survives reload                  └─ the row comes back by broadcast
 *                                              or by seed, and settles the entry
 *
 * Invariants:
 *   - AtMostOneRowPerClientId — a client id yields at most one server row,
 *     however many times its entry is flushed.
 *   - NoPhantomTasks — a row on a device exists on the server. (A pending entry
 *     is in the outbox by construction: the outbox IS what renders as pending.)
 *   - NoDoubleDisplay — a capture is never on one screen twice, as a pending
 *     entry and as the server's row. Found while modelling: a lost response
 *     still broadcasts, so the row reaches the device that is still holding the
 *     entry. Both roads back — broadcast and seed — must settle it.
 *   - NoLostCapture — a capture is on the server or in an outbox, always.
 *   - Converged — a device whose socket is up and has nothing left to hear
 *     shows exactly what the server holds. This is "eventual convergence" as
 *     docs/tasks-v1.md words it: a safety property conditioned on quiescence.
 *   - NoLostDeletes — Converged read for one value, kept by name.
 *
 * Not modelled: the gap between a socket's subscribe and its seed response
 * (`seed` is one atomic step), edits other than delete, and the task tree.
 */

export type RowState = 'absent' | 'live' | 'deleted';

export interface TaskBroadcast {
  cid: string;
  kind: 'created' | 'deleted';
}

/** Sets are sorted arrays, so one state has one JSON spelling. */
export interface ConvergenceState {
  /** Rows on the server bearing each client id. */
  serverCount: Record<string, number>;
  serverDeleted: Record<string, boolean>;
  /** Client ids already used by a capture. A UUID is minted once. */
  minted: string[];
  /** IndexedDB, per device: survives a reload. Rendered as the pending rows. */
  outbox: Record<string, string[]>;
  /** The server rows each device has on show. */
  rows: Record<string, Record<string, RowState>>;
  /** Socket up, and seeded since it opened. */
  fresh: Record<string, boolean>;
  /** Broadcasts on each device's socket, in order. */
  queue: Record<string, TaskBroadcast[]>;
}

export interface ConvergenceModel {
  devices: readonly string[];
  clientIds: readonly string[];
  maxQueue: number;
}

/** One way to break the model per invariant. All false is the real system. */
export interface Faults {
  /** The server inserts on every flush. */
  noDedupe: boolean;
  /** A broadcast bearing an outbox entry's client id leaves the entry. */
  deliverKeepsEntry: boolean;
  /** A seeded row bearing an outbox entry's client id leaves the entry. */
  seedKeepsEntry: boolean;
  /** A delete is not broadcast. */
  silentDelete: boolean;
  /** The outbox lives in memory and a dropped session empties it. */
  volatileOutbox: boolean;
  /** Capture shows a server row before the server has one. */
  phantomCapture: boolean;
}

export const NO_FAULTS: Faults = {
  noDedupe: false,
  deliverKeepsEntry: false,
  seedKeepsEntry: false,
  silentDelete: false,
  volatileOutbox: false,
  phantomCapture: false,
};

export function initialState(model: ConvergenceModel): ConvergenceState {
  const state: ConvergenceState = {
    serverCount: {},
    serverDeleted: {},
    minted: [],
    outbox: {},
    rows: {},
    fresh: {},
    queue: {},
  };
  for (const c of model.clientIds) {
    state.serverCount[c] = 0;
    state.serverDeleted[c] = false;
  }
  for (const d of model.devices) {
    state.outbox[d] = [];
    state.fresh[d] = false;
    state.queue[d] = [];
    const row: Record<string, RowState> = {};
    for (const c of model.clientIds) row[c] = 'absent';
    state.rows[d] = row;
  }
  return state;
}

function copy(state: ConvergenceState): ConvergenceState {
  return structuredClone(state);
}

function without(set: readonly string[], member: string): string[] {
  return set.filter((m) => m !== member);
}

function withMember(set: readonly string[], member: string): string[] {
  return [...without(set, member), member].sort();
}

export function serverView(state: ConvergenceState, c: string): RowState {
  if ((state.serverCount[c] ?? 0) === 0) return 'absent';
  return state.serverDeleted[c] === true ? 'deleted' : 'live';
}

/**
 * The server tells every socket that is up. A socket that is down hears
 * nothing, ever: the server keeps no per-client log.
 */
function broadcast(state: ConvergenceState, event: TaskBroadcast): void {
  for (const d of Object.keys(state.queue)) {
    if (state.fresh[d] === true) state.queue[d] = [...(state.queue[d] ?? []), event];
  }
}

/**
 * POST /tasks with the client id. The server inserts ONLY when it holds no row
 * for that id, and only an insert is broadcast.
 */
function serverAccepts(state: ConvergenceState, c: string, faults: Faults): void {
  const held = state.serverCount[c] ?? 0;
  if (held === 0 || faults.noDedupe) {
    state.serverCount[c] = held + 1;
    broadcast(state, { cid: c, kind: 'created' });
  }
}

/** Every action returns the next state, or null where its guard is false. */
export function capture(
  state: ConvergenceState,
  d: string,
  c: string,
  faults: Faults = NO_FAULTS,
): ConvergenceState | null {
  if (state.minted.includes(c)) return null;
  const next = copy(state);
  next.minted = withMember(next.minted, c);
  next.outbox[d] = withMember(next.outbox[d] ?? [], c);
  if (faults.phantomCapture) next.rows[d] = { ...next.rows[d], [c]: 'live' };
  return next;
}

/** The response arrives: the entry goes, the server's row takes its place. */
export function flushAcked(
  state: ConvergenceState,
  d: string,
  c: string,
  faults: Faults = NO_FAULTS,
): ConvergenceState | null {
  if (!(state.outbox[d] ?? []).includes(c)) return null;
  const next = copy(state);
  serverAccepts(next, c, faults);
  next.outbox[d] = without(next.outbox[d] ?? [], c);
  next.rows[d] = { ...next.rows[d], [c]: state.serverDeleted[c] === true ? 'deleted' : 'live' };
  return next;
}

/**
 * The server commits and the response is lost. The entry stays, and will be
 * flushed again. This is the step the dedupe exists for.
 */
export function flushLost(
  state: ConvergenceState,
  d: string,
  c: string,
  faults: Faults = NO_FAULTS,
): ConvergenceState | null {
  if (!(state.outbox[d] ?? []).includes(c)) return null;
  const next = copy(state);
  serverAccepts(next, c, faults);
  return next;
}

/**
 * A broadcast lands. One that names a client id still in this device's outbox
 * is the lost response arriving by the other road: the entry goes.
 */
export function deliver(
  state: ConvergenceState,
  d: string,
  faults: Faults = NO_FAULTS,
): ConvergenceState | null {
  const [head, ...tail] = state.queue[d] ?? [];
  if (head === undefined) return null;
  const next = copy(state);
  next.queue[d] = tail;
  next.rows[d] = { ...next.rows[d], [head.cid]: head.kind === 'deleted' ? 'deleted' : 'live' };
  if (!faults.deliverKeepsEntry) next.outbox[d] = without(next.outbox[d] ?? [], head.cid);
  return next;
}

/**
 * Only a row the server has confirmed can be deleted; a pending one has no id
 * to delete by.
 */
export function deleteTask(
  state: ConvergenceState,
  d: string,
  c: string,
  faults: Faults = NO_FAULTS,
): ConvergenceState | null {
  if (state.rows[d]?.[c] !== 'live') return null;
  const next = copy(state);
  next.serverDeleted[c] = true;
  next.rows[d] = { ...next.rows[d], [c]: 'deleted' };
  if (!faults.silentDelete) broadcast(next, { cid: c, kind: 'deleted' });
  return next;
}

/**
 * The socket drops, or the page reloads with no network. Broadcasts on the old
 * socket are gone. The rows stay as they were — after a reload they come back
 * from the list copy — and may now be stale. The outbox is untouched.
 */
export function drop(
  state: ConvergenceState,
  d: string,
  faults: Faults = NO_FAULTS,
): ConvergenceState | null {
  if (state.fresh[d] !== true) return null;
  const next = copy(state);
  next.fresh[d] = false;
  next.queue[d] = [];
  if (faults.volatileOutbox) next.outbox[d] = [];
  return next;
}

/**
 * The socket opens and the list is fetched. A fetched row that bears the
 * client id of an outbox entry settles that entry, as `deliver` does.
 */
export function seed(
  state: ConvergenceState,
  d: string,
  faults: Faults = NO_FAULTS,
): ConvergenceState | null {
  if (state.fresh[d] === true) return null;
  const next = copy(state);
  next.fresh[d] = true;
  const row: Record<string, RowState> = {};
  for (const c of Object.keys(state.serverCount)) row[c] = serverView(state, c);
  next.rows[d] = row;
  if (!faults.seedKeepsEntry) {
    next.outbox[d] = (next.outbox[d] ?? []).filter((c) => (state.serverCount[c] ?? 0) === 0);
  }
  return next;
}

export interface Invariant {
  name: string;
  holds: (state: ConvergenceState, model: ConvergenceModel) => boolean;
}

function quiet(state: ConvergenceState, d: string): boolean {
  return state.fresh[d] === true && (state.queue[d] ?? []).length === 0;
}

export const INVARIANTS: readonly Invariant[] = [
  {
    name: 'AtMostOneRowPerClientId',
    holds: (s, m) => m.clientIds.every((c) => (s.serverCount[c] ?? 0) <= 1),
  },
  {
    name: 'NoPhantomTasks',
    holds: (s, m) =>
      m.devices.every((d) =>
        m.clientIds.every((c) => s.rows[d]?.[c] === 'absent' || (s.serverCount[c] ?? 0) >= 1),
      ),
  },
  {
    name: 'NoDoubleDisplay',
    holds: (s, m) =>
      m.devices.every((d) => (s.outbox[d] ?? []).every((c) => s.rows[d]?.[c] === 'absent')),
  },
  {
    name: 'NoLostCapture',
    holds: (s, m) =>
      s.minted.every(
        (c) => (s.serverCount[c] ?? 0) >= 1 || m.devices.some((d) => (s.outbox[d] ?? []).includes(c)),
      ),
  },
  {
    name: 'Converged',
    holds: (s, m) =>
      m.devices.every(
        (d) => !quiet(s, d) || m.clientIds.every((c) => s.rows[d]?.[c] === serverView(s, c)),
      ),
  },
  {
    name: 'NoLostDeletes',
    holds: (s, m) =>
      m.devices.every(
        (d) =>
          !quiet(s, d) ||
          m.clientIds.every((c) => s.serverDeleted[c] !== true || s.rows[d]?.[c] !== 'live'),
      ),
  },
];

/** Every state one step from `state`. */
export function successors(
  state: ConvergenceState,
  model: ConvergenceModel,
  faults: Faults = NO_FAULTS,
): ConvergenceState[] {
  const out: Array<ConvergenceState | null> = [];
  for (const d of model.devices) {
    for (const c of model.clientIds) {
      out.push(capture(state, d, c, faults));
      out.push(flushAcked(state, d, c, faults));
      out.push(flushLost(state, d, c, faults));
      out.push(deleteTask(state, d, c, faults));
    }
    out.push(deliver(state, d, faults));
    out.push(drop(state, d, faults));
    out.push(seed(state, d, faults));
  }
  return out.filter((s): s is ConvergenceState => s !== null);
}

export interface Exploration {
  distinctStates: number;
  /** The first invariant found false, in `INVARIANTS` order, or null. */
  violated: string | null;
}

/**
 * Breadth-first over every reachable state. The queue bound is TLC's
 * CONSTRAINT, with TLC's meaning: a state past it is discarded — not counted,
 * not checked, not expanded.
 */
export function explore(
  model: ConvergenceModel,
  faults: Faults = NO_FAULTS,
  invariants: readonly Invariant[] = INVARIANTS,
): Exploration {
  const start = initialState(model);
  const seen = new Set<string>([JSON.stringify(start)]);
  let frontier: ConvergenceState[] = [start];
  while (frontier.length > 0) {
    const nextFrontier: ConvergenceState[] = [];
    for (const state of frontier) {
      for (const invariant of invariants) {
        if (!invariant.holds(state, model)) {
          return { distinctStates: seen.size, violated: invariant.name };
        }
      }
      for (const next of successors(state, model, faults)) {
        if (model.devices.some((d) => (next.queue[d] ?? []).length > model.maxQueue)) continue;
        const key = JSON.stringify(next);
        if (seen.has(key)) continue;
        seen.add(key);
        nextFrontier.push(next);
      }
    }
    frontier = nextFrontier;
  }
  return { distinctStates: seen.size, violated: null };
}
