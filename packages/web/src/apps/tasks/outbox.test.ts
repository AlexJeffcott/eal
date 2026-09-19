import { beforeEach, describe, expect, test } from 'bun:test';
import { ServerRefusedError, type CreateTaskInput, type CurrentUser, type Task } from '@eal/client';
import {
  createTaskOutbox,
  isRetryable,
  type OutboxEntry,
  type OutboxSignals,
  type OutboxStorage,
  type TaskOutbox,
} from './outbox.ts';

/**
 * The outbox's logic against an in-memory `OutboxStorage` and a scripted
 * server. What this cannot show — that IndexedDB really holds an entry across a
 * reload, and that the real server really deduplicates — is
 * scripts/e2e-offline-capture.ts.
 */

const ALEX: CurrentUser = { userId: 1, displayName: 'alex' };
const ELISA: CurrentUser = { userId: 2, displayName: 'elisa' };

function task(id: number, title: string, clientId: string | null): Task {
  return {
    id,
    parentId: null,
    title,
    notes: '',
    status: 'todo',
    kind: 'task',
    deferUntil: null,
    dueAt: null,
    createdBy: 1,
    assignedTo: null,
    updatedBy: 1,
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
    completedAt: null,
    deletedAt: null,
    position: 0,
    sequential: false,
    clientId,
  };
}

/** A device's disk: outlives any one `createTaskOutbox`, as IndexedDB does a reload. */
class MemoryStorage implements OutboxStorage {
  entries = new Map<string, OutboxEntry>();
  snapshots = new Map<number, Task[]>();
  snapshotWrites = 0;
  failPuts = false;
  /** Called at the top of every `putSnapshot`, so a test can change the list mid-write. */
  onSnapshotWrite: (() => void) | null = null;

  async putEntry(entry: OutboxEntry): Promise<void> {
    if (this.failPuts) throw new Error('QuotaExceededError');
    this.entries.set(entry.clientId, entry);
  }
  async deleteEntry(clientId: string): Promise<void> {
    this.entries.delete(clientId);
  }
  async listEntries(userId: number): Promise<OutboxEntry[]> {
    return [...this.entries.values()]
      .filter((e) => e.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async putSnapshot(userId: number, tasks: readonly Task[]): Promise<void> {
    this.snapshotWrites += 1;
    this.onSnapshotWrite?.();
    this.snapshots.set(userId, [...tasks]);
  }
  async getSnapshot(userId: number): Promise<Task[] | null> {
    return this.snapshots.get(userId) ?? null;
  }
  async clear(): Promise<void> {
    this.entries.clear();
    this.snapshots.clear();
  }
}

/** The server, as far as `createTask` can see it — including its dedupe. */
class ScriptedServer {
  rows = new Map<string, Task>();
  calls: CreateTaskInput[] = [];
  /** Thrown by the next calls, in order, before the server sees anything. */
  failures: unknown[] = [];
  /** What the storage held at the moment each request was made. */
  storedAtCall: string[][] = [];
  private nextId = 100;

  constructor(private readonly storage: MemoryStorage) {}

  createTask = async (input: CreateTaskInput): Promise<Task> => {
    this.calls.push(input);
    this.storedAtCall.push([...this.storage.entries.keys()]);
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    const key = input.clientId ?? `anon-${this.nextId}`;
    const existing = this.rows.get(key);
    if (existing) return existing;
    const row = task(this.nextId++, input.title, input.clientId ?? null);
    this.rows.set(key, row);
    return row;
  };
}

interface Rig {
  storage: MemoryStorage;
  server: ScriptedServer;
  signals: OutboxSignals;
  outbox: TaskOutbox;
  lockNames: string[];
  /** A second tab, or the same tab after a reload: new memory, same disk. */
  reload(): Rig;
}

function rig(storage = new MemoryStorage(), server = new ScriptedServer(storage)): Rig {
  const signals: OutboxSignals = {
    $outbox: { value: [] },
    $tasksById: { value: new Map() },
    $tasksError: { value: null },
    $quickAddTitle: { value: '' },
    $currentUser: { value: ALEX },
  };
  const lockNames: string[] = [];
  let minted = storage.entries.size;
  let clock = 0;
  const outbox = createTaskOutbox(
    {
      client: server,
      storage,
      locks: null,
      newClientId: () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`,
      now: () => new Date(Date.UTC(2026, 8, 19, 10, 0, clock++)).toISOString(),
      describeError: (err) => `friendly: ${err instanceof Error ? err.message : String(err)}`,
    },
    signals,
  );
  return { storage, server, signals, outbox, lockNames, reload: () => rig(storage, server) };
}

const NO_RESPONSE = (): TypeError => new TypeError('Failed to fetch');

describe('isRetryable', () => {
  test('no response, an unwell server and a lapsed session all mean "send it again"', () => {
    expect(isRetryable(NO_RESPONSE())).toBe(true);
    for (const status of [500, 502, 503, 401, 403, 408, 429]) {
      expect(isRetryable(new ServerRefusedError(status, 'x'))).toBe(true);
    }
  });

  test('the server reading the request and refusing it does not', () => {
    for (const status of [400, 404, 409, 422]) {
      expect(isRetryable(new ServerRefusedError(status, 'x'))).toBe(false);
    }
    expect(isRetryable(new Error('would create cycle'))).toBe(false);
    expect(isRetryable('nope')).toBe(false);
  });
});

describe('capture', () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  test('the entry is on disk before the request is made', async () => {
    await r.outbox.capture({ title: 'buy milk', parentId: null });
    expect(r.server.calls).toHaveLength(1);
    expect(r.server.storedAtCall[0]).toEqual([r.server.calls[0]?.clientId ?? 'missing']);
  });

  test('online: the row takes the entry\'s place and nothing is left queued', async () => {
    await r.outbox.capture({ title: 'buy milk', parentId: null });
    expect(r.signals.$outbox.value).toEqual([]);
    expect(r.storage.entries.size).toBe(0);
    expect([...r.signals.$tasksById.value.values()].map((t) => t.title)).toEqual(['buy milk']);
    expect(r.signals.$tasksError.value).toBeNull();
  });

  test('the parent rides along only when there is one', async () => {
    await r.outbox.capture({ title: 'root', parentId: null });
    await r.outbox.capture({ title: 'inside', parentId: 7 });
    expect('parentId' in (r.server.calls[0] ?? {})).toBe(false);
    expect(r.server.calls[1]?.parentId).toBe(7);
  });

  test('no response: the entry stays, pending, with no error', async () => {
    r.server.failures = [NO_RESPONSE()];
    await r.outbox.capture({ title: 'in the tunnel', parentId: null });
    expect(r.signals.$outbox.value.map((e) => e.title)).toEqual(['in the tunnel']);
    expect(r.storage.entries.size).toBe(1);
    expect(r.signals.$tasksById.value.size).toBe(0);
    expect(r.signals.$tasksError.value).toBeNull();
    expect(r.signals.$quickAddTitle.value).toBe('');
  });

  test('a refusal drops the entry, says why, and hands the title back', async () => {
    r.server.failures = [new ServerRefusedError(404, 'parent task 9 not found')];
    await r.outbox.capture({ title: 'orphan', parentId: 9 });
    expect(r.signals.$outbox.value).toEqual([]);
    expect(r.storage.entries.size).toBe(0);
    expect(r.signals.$tasksError.value).toBe('friendly: parent task 9 not found');
    expect(r.signals.$quickAddTitle.value).toBe('orphan');
  });

  test('a refusal does not overwrite what the user has typed since', async () => {
    r.server.failures = [new ServerRefusedError(400, 'no')];
    r.signals.$quickAddTitle.value = 'already typing the next one';
    await r.outbox.capture({ title: 'refused', parentId: null });
    expect(r.signals.$quickAddTitle.value).toBe('already typing the next one');
  });

  test('a disk that refuses the write does not stop the capture going out', async () => {
    r.storage.failPuts = true;
    await r.outbox.capture({ title: 'private mode', parentId: null });
    expect([...r.signals.$tasksById.value.values()].map((t) => t.title)).toEqual(['private mode']);
  });

  test('and with no disk and no response it still waits in memory, and still goes', async () => {
    r.storage.failPuts = true;
    r.server.failures = [NO_RESPONSE()];
    await r.outbox.capture({ title: 'private mode', parentId: null });
    expect(r.signals.$outbox.value).toHaveLength(1);
    await r.outbox.flush();
    expect(r.signals.$outbox.value).toEqual([]);
    expect(r.server.rows.size).toBe(1);
  });

  test('signed out, nothing is captured', async () => {
    r.signals.$currentUser.value = null;
    await r.outbox.capture({ title: 'nobody', parentId: null });
    expect(r.server.calls).toEqual([]);
    expect(r.storage.entries.size).toBe(0);
  });
});

describe('flush', () => {
  test('a retry carries the SAME client id, so the server makes one row', async () => {
    const r = rig();
    // The cruel case: the server commits, and the response is what is lost.
    const original = r.server.createTask;
    let lost = false;
    r.server.createTask = async (input) => {
      const row = await original(input);
      if (!lost) {
        lost = true;
        throw NO_RESPONSE();
      }
      return row;
    };
    await r.outbox.capture({ title: 'once', parentId: null });
    expect(r.signals.$outbox.value).toHaveLength(1);

    await r.outbox.flush();
    expect(r.server.calls).toHaveLength(2);
    expect(r.server.calls[1]?.clientId).toBe(r.server.calls[0]?.clientId ?? 'missing');
    expect(r.server.rows.size).toBe(1);
    expect(r.signals.$outbox.value).toEqual([]);
    expect(r.signals.$tasksById.value.size).toBe(1);
  });

  test('an entry survives a reload, shows as pending at once, and is then sent', async () => {
    const before = rig();
    before.server.failures = [NO_RESPONSE()];
    await before.outbox.capture({ title: 'written before the reload', parentId: null });

    const after = before.reload();
    expect(after.signals.$outbox.value).toEqual([]);
    await after.outbox.load();
    expect(after.signals.$outbox.value.map((e) => e.title)).toEqual(['written before the reload']);

    await after.outbox.flush();
    expect(after.signals.$outbox.value).toEqual([]);
    expect(after.server.rows.size).toBe(1);
    expect(after.server.calls[1]?.clientId).toBe(after.server.calls[0]?.clientId ?? 'missing');
  });

  test('oldest first, and it stops at the first non-answer without losing the rest', async () => {
    const r = rig();
    r.server.failures = [NO_RESPONSE(), NO_RESPONSE(), NO_RESPONSE()];
    await r.outbox.capture({ title: 'first', parentId: null });
    await r.outbox.capture({ title: 'second', parentId: null });
    // Three requests so far: 'first'; then 'first' again ahead of 'second' —
    // and that flush stopped there, so 'second' has never been sent.
    expect(r.server.calls.map((c) => c.title)).toEqual(['first', 'first']);

    await r.outbox.flush();
    expect(r.server.calls.map((c) => c.title)).toEqual(['first', 'first', 'first']);
    expect(r.signals.$outbox.value.map((e) => e.title)).toEqual(['first', 'second']);

    await r.outbox.flush();
    expect(r.signals.$outbox.value).toEqual([]);
    expect([...r.server.rows.values()].map((t) => t.title)).toEqual(['first', 'second']);
  });

  test('a refusal in the middle does not strand the entries behind it', async () => {
    const r = rig();
    r.server.failures = [NO_RESPONSE(), NO_RESPONSE()];
    await r.outbox.capture({ title: 'bad', parentId: 9 });
    await r.outbox.capture({ title: 'good', parentId: null });
    r.server.failures = [new ServerRefusedError(404, 'parent task 9 not found')];
    await r.outbox.flush();
    expect(r.signals.$outbox.value).toEqual([]);
    expect([...r.server.rows.values()].map((t) => t.title)).toEqual(['good']);
    expect(r.signals.$tasksError.value).toBe('friendly: parent task 9 not found');
  });

  test('two flushes asked for at once send each entry once', async () => {
    const r = rig();
    r.server.failures = [NO_RESPONSE()];
    await r.outbox.capture({ title: 'once', parentId: null });
    await Promise.all([r.outbox.flush(), r.outbox.flush(), r.outbox.flush()]);
    expect(r.server.calls).toHaveLength(2);
  });

  test('another member\'s entries are neither shown nor sent', async () => {
    const alex = rig();
    alex.server.failures = [NO_RESPONSE()];
    await alex.outbox.capture({ title: "alex's", parentId: null });

    const elisa = alex.reload();
    elisa.signals.$currentUser.value = ELISA;
    await elisa.outbox.load();
    await elisa.outbox.flush();
    expect(elisa.signals.$outbox.value).toEqual([]);
    expect(elisa.server.calls).toHaveLength(1);
    expect(elisa.storage.entries.size).toBe(1);
  });

  test('it asks for the cross-tab lock by name, and runs inside it', async () => {
    const storage = new MemoryStorage();
    const server = new ScriptedServer(storage);
    const requested: string[] = [];
    let inside = false;
    const original = server.createTask;
    const sentInside: boolean[] = [];
    server.createTask = (input) => {
      sentInside.push(inside);
      return original(input);
    };
    const signals: OutboxSignals = {
      $outbox: { value: [] },
      $tasksById: { value: new Map() },
      $tasksError: { value: null },
      $quickAddTitle: { value: '' },
      $currentUser: { value: ALEX },
    };
    const locks = {
      request: async (name: string, work: () => Promise<void>): Promise<void> => {
        requested.push(name);
        inside = true;
        try {
          await work();
        } finally {
          inside = false;
        }
      },
    };
    const outbox = createTaskOutbox(
      {
        client: server,
        storage,
        // Structural: the outbox uses `request(name, callback)` and nothing else.
        locks: Object.assign(Object.create(null), locks),
        newClientId: () => '00000000-0000-4000-8000-000000000001',
        now: () => '2026-09-19T10:00:00.000Z',
        describeError: String,
      },
      signals,
    );
    await outbox.capture({ title: 'locked', parentId: null });
    expect(requested).toEqual(['eal-task-outbox']);
    expect(sentInside).toEqual([true]);
  });
});

describe('reconcile — the row comes back by the other road', () => {
  test('a broadcast bearing a queued client id settles the entry, and it is not sent again', async () => {
    const r = rig();
    r.server.failures = [NO_RESPONSE()];
    await r.outbox.capture({ title: 'lost response', parentId: null });
    const clientId = r.signals.$outbox.value[0]?.clientId ?? 'missing';

    r.outbox.reconcile([task(55, 'lost response', clientId)]);
    expect(r.signals.$outbox.value).toEqual([]);

    await r.outbox.flush();
    expect(r.server.calls).toHaveLength(1);
    expect(r.storage.entries.size).toBe(0);
  });

  test('a flush that lists the disk before the delete lands does not resurrect the entry', async () => {
    const r = rig();
    r.server.failures = [NO_RESPONSE()];
    await r.outbox.capture({ title: 'lost response', parentId: null });
    const entry = r.signals.$outbox.value[0];
    if (!entry) throw new Error('no entry');
    // A disk whose delete never lands.
    r.storage.deleteEntry = async () => {};

    r.outbox.reconcile([task(55, 'lost response', entry.clientId)]);
    await r.outbox.flush();
    expect(r.signals.$outbox.value).toEqual([]);
    expect(r.server.calls).toHaveLength(1);
  });

  test('rows with no client id, or one that is not queued, change nothing', async () => {
    const r = rig();
    r.server.failures = [NO_RESPONSE()];
    await r.outbox.capture({ title: 'mine', parentId: null });
    r.outbox.reconcile([task(1, 'theirs', null), task(2, 'other', 'ffffffff-0000-4000-8000-000000000000')]);
    expect(r.signals.$outbox.value).toHaveLength(1);
  });
});

describe('the list copy', () => {
  test('nothing is written until a seed has succeeded', async () => {
    const r = rig();
    r.signals.$tasksById.value = new Map([[1, task(1, 'a', null)]]);
    await r.outbox.saveSnapshot();
    expect(r.storage.snapshotWrites).toBe(0);

    r.outbox.armSnapshot();
    await r.outbox.saveSnapshot();
    expect(r.storage.snapshots.get(1)?.map((t) => t.title)).toEqual(['a']);
  });

  test('an empty boot cannot overwrite a good copy', async () => {
    const first = rig();
    first.outbox.armSnapshot();
    first.signals.$tasksById.value = new Map([[1, task(1, 'kept', null)]]);
    await first.outbox.saveSnapshot();

    const boot = first.reload();
    await boot.outbox.saveSnapshot();
    expect(boot.storage.snapshots.get(1)?.map((t) => t.title)).toEqual(['kept']);
  });

  test('a change during a write is followed by one more write, carrying the newest list', async () => {
    const r = rig();
    r.outbox.armSnapshot();
    r.signals.$tasksById.value = new Map([[1, task(1, 'old', null)]]);
    r.storage.onSnapshotWrite = () => {
      r.storage.onSnapshotWrite = null;
      r.signals.$tasksById.value = new Map([[1, task(1, 'new', null)]]);
      void r.outbox.saveSnapshot();
    };
    await r.outbox.saveSnapshot();
    expect(r.storage.snapshotWrites).toBe(2);
    expect(r.storage.snapshots.get(1)?.map((t) => t.title)).toEqual(['new']);
  });

  test('it fills an empty list, and only an empty one', async () => {
    const first = rig();
    first.outbox.armSnapshot();
    first.signals.$tasksById.value = new Map([[1, task(1, 'from last time', null)]]);
    await first.outbox.saveSnapshot();

    const offline = first.reload();
    expect(await offline.outbox.restoreSnapshot()).toBe(true);
    expect([...offline.signals.$tasksById.value.values()].map((t) => t.title)).toEqual([
      'from last time',
    ]);

    offline.signals.$tasksById.value = new Map([[2, task(2, 'live', null)]]);
    expect(await offline.outbox.restoreSnapshot()).toBe(false);
    expect([...offline.signals.$tasksById.value.values()].map((t) => t.title)).toEqual(['live']);
  });

  test('no copy, another member\'s copy, or nobody signed in: nothing is restored', async () => {
    const r = rig();
    expect(await r.outbox.restoreSnapshot()).toBe(false);

    r.storage.snapshots.set(ELISA.userId, [task(1, "elisa's", null)]);
    expect(await r.outbox.restoreSnapshot()).toBe(false);

    r.signals.$currentUser.value = null;
    expect(await r.outbox.restoreSnapshot()).toBe(false);
  });
});

describe('clear — sign-out', () => {
  test('both stores are emptied, the count of unsent captures is reported, and the copy is disarmed', async () => {
    const r = rig();
    r.server.failures = [NO_RESPONSE()];
    await r.outbox.capture({ title: 'unsent', parentId: null });
    r.outbox.armSnapshot();
    r.signals.$tasksById.value = new Map([[1, task(1, 'a', null)]]);
    await r.outbox.saveSnapshot();

    expect(await r.outbox.clear()).toBe(1);
    expect(r.signals.$outbox.value).toEqual([]);
    expect(r.storage.entries.size).toBe(0);
    expect(r.storage.snapshots.size).toBe(0);

    await r.outbox.saveSnapshot();
    expect(r.storage.snapshots.size).toBe(0);
  });
});
