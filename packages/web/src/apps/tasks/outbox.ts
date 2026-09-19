/**
 * The capture outbox, and the copy of the task list kept beside it — Plan 06
 * part B, docs/plans/06-offline-capture.md.
 *
 * Quick-add no longer posts and hopes. It writes an entry here first, shows it
 * as pending, and then sends it; the entry goes only when the server's row has
 * come back. An entry survives a reload and a cold start, and is sent again
 * whenever it is not known to have arrived — on boot, on `online`, and on every
 * `connected`. The server makes that safe: a create that carries a client id it
 * already holds returns the first row (api: handlers/tasks.shared.ts,
 * `createTaskOnce`).
 *
 * The model is specs/tla/tasks-convergence/TasksConvergence.tla. Two of its
 * findings are load-bearing here:
 *
 *   - NoDoubleDisplay. A create whose response is lost still broadcasts, so
 *     the server's row reaches the device that still holds the entry — by
 *     broadcast if the socket is up, by seed if it was not. `reconcile` is
 *     called on both roads and settles the entry by its client id.
 *   - NoLostCapture. Nothing removes an entry except the server's row, or the
 *     server saying no. No response at all is never a reason.
 *
 * The list copy is the other half of "the app opens with no signal": without it
 * an offline cold boot shows an empty list, and a capture lands in a list that
 * looks deleted. It is written after every change once a seed has succeeded,
 * and read on ONE path — a seed that failed with no response, into a list that
 * is still empty. Reading it before every connect would let the server's list
 * replace rows under the user a second later.
 *
 * Storage is injected (`OutboxStorage`), so this file is the logic and
 * outbox-idb.ts is the IndexedDB. The proof that the two work together, across
 * a killed server and a reload, is scripts/e2e-offline-capture.ts.
 */
import { ServerRefusedError, type CurrentUser, type EalClient, type Task } from '@eal/client';

export interface OutboxEntry {
  /** The UUID the server deduplicates on. */
  clientId: string;
  /**
   * Who captured it. Sign-out clears the outbox, so this should never matter —
   * and if that clear ever fails, this is what stops the next member's session
   * from sending the last member's captures as its own.
   */
  userId: number;
  title: string;
  parentId: number | null;
  createdAt: string;
}

export interface OutboxStorage {
  putEntry(entry: OutboxEntry): Promise<void>;
  deleteEntry(clientId: string): Promise<void>;
  /** Oldest first. */
  listEntries(userId: number): Promise<OutboxEntry[]>;
  putSnapshot(userId: number, tasks: readonly Task[]): Promise<void>;
  getSnapshot(userId: number): Promise<Task[] | null>;
  clear(): Promise<void>;
}

/** A writable reactive value — structurally, a polly `$state` signal. */
interface Cell<T> {
  value: T;
}

export interface OutboxSignals {
  $outbox: Cell<OutboxEntry[]>;
  $tasksById: Cell<Map<number, Task>>;
  $tasksError: Cell<string | null>;
  $quickAddTitle: Cell<string>;
  $currentUser: Cell<CurrentUser | null>;
}

export interface OutboxDeps {
  client: Pick<EalClient, 'createTask'>;
  storage: OutboxStorage;
  /** `null` where the browser has no Web Locks; see `withFlushLock`. */
  locks: LockManager | null;
  newClientId: () => string;
  now: () => string;
  /** The words for a refusal — `friendlyTaskError`, passed in to avoid a cycle. */
  describeError: (err: unknown) => string;
}

export interface TaskOutbox {
  /** Read this user's entries into `$outbox`. Called when a session starts. */
  load(): Promise<void>;
  capture(input: { title: string; parentId: number | null }): Promise<void>;
  /** Send every queued entry, oldest first. Stops at the first non-answer. */
  flush(): Promise<void>;
  /** Settle any entry whose server row is among `tasks`. */
  reconcile(tasks: Iterable<Task>): void;
  /** A seed has succeeded: the list is the server's, and may now be copied. */
  armSnapshot(): void;
  saveSnapshot(): Promise<void>;
  /** Fill an EMPTY list from the copy. Resolves true if it did. */
  restoreSnapshot(): Promise<boolean>;
  /** Sign-out. Resolves with how many unsent captures were discarded. */
  clear(): Promise<number>;
}

const FLUSH_LOCK = 'eal-task-outbox';

/**
 * Does this failure leave the capture's fate unknown, or merely deferred?
 *
 * No response (`fetch` rejects with a TypeError) and a server that is unwell
 * (5xx, or the proxy's 502 during a deploy) both mean "send it again". So do
 * 401 and 403: an expired session is a reason to sign in, not a reason to
 * discard what the user wrote. Everything else is the server reading the
 * request and refusing it, and sending it again would be refused again.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (!(err instanceof ServerRefusedError)) return false;
  return err.status >= 500 || [401, 403, 408, 429].includes(err.status);
}

export function createTaskOutbox(deps: OutboxDeps, signals: OutboxSignals): TaskOutbox {
  /** Runs of `flushOnce`, end to end: two never overlap in one tab. */
  let flushTail: Promise<void> = Promise.resolve();
  let snapshotArmed = false;
  let snapshotWriting = false;
  let snapshotDirty = false;

  function isQueued(clientId: string): boolean {
    return signals.$outbox.value.some((e) => e.clientId === clientId);
  }

  /**
   * Client ids this tab has seen settled or refused. The stored entry is
   * deleted a moment AFTER the signal forgets it, so a flush that lists storage
   * in that moment would otherwise bring the entry back onto the screen.
   */
  const finished = new Set<string>();

  function forget(clientId: string): void {
    finished.add(clientId);
    signals.$outbox.value = signals.$outbox.value.filter((e) => e.clientId !== clientId);
  }

  async function deleteStored(clientId: string): Promise<void> {
    try {
      await deps.storage.deleteEntry(clientId);
    } catch (err) {
      // The entry will be sent once more on the next boot, and the server
      // will answer with the row it already has.
      console.warn('[outbox] could not delete a settled entry:', err);
    }
  }

  /** The server's row has come back: it takes the entry's place. */
  async function settle(clientId: string, task: Task): Promise<void> {
    forget(clientId);
    const next = new Map(signals.$tasksById.value);
    next.set(task.id, task);
    signals.$tasksById.value = next;
    await deleteStored(clientId);
  }

  /** The server read the request and said no. */
  async function refuse(entry: OutboxEntry, err: unknown): Promise<void> {
    forget(entry.clientId);
    signals.$tasksError.value = deps.describeError(err);
    // Hand the words back so the user can fix and retry without retyping —
    // unless they have already started on the next thing.
    if (signals.$quickAddTitle.value === '') signals.$quickAddTitle.value = entry.title;
    await deleteStored(entry.clientId);
  }

  /**
   * One tab flushes at a time. Two tabs replaying the same entry is safe — the
   * server deduplicates — and is still two requests where one will do, and two
   * writers racing to settle one entry. Without Web Locks the flush just runs:
   * correctness never depended on the lock.
   */
  function withFlushLock(work: () => Promise<void>): Promise<void> {
    if (deps.locks === null) return work();
    return deps.locks.request(FLUSH_LOCK, work);
  }

  async function flushOnce(): Promise<void> {
    const user = signals.$currentUser.value;
    if (user === null) return;

    // Storage is the truth — it holds what other tabs captured too. Entries
    // that are only in memory (their write failed) are kept alongside.
    let stored: OutboxEntry[] = [];
    try {
      stored = await deps.storage.listEntries(user.userId);
    } catch (err) {
      console.warn('[outbox] could not read the stored entries:', err);
    }
    stored = stored.filter((e) => !finished.has(e.clientId));
    const known = new Set(stored.map((e) => e.clientId));
    const queue = [...stored, ...signals.$outbox.value.filter((e) => !known.has(e.clientId))];
    signals.$outbox.value = queue;

    for (const entry of queue) {
      // A broadcast can settle an entry while an earlier one is in flight.
      if (!isQueued(entry.clientId)) continue;
      try {
        const task = await deps.client.createTask(
          entry.parentId === null
            ? { title: entry.title, clientId: entry.clientId }
            : { title: entry.title, clientId: entry.clientId, parentId: entry.parentId },
        );
        await settle(entry.clientId, task);
      } catch (err) {
        // No answer. The rest would get none either, and order is kept.
        if (isRetryable(err)) return;
        await refuse(entry, err);
      }
    }
  }

  function flush(): Promise<void> {
    flushTail = flushTail.then(() => withFlushLock(flushOnce)).catch((err: unknown) => {
      console.warn('[outbox] flush failed:', err);
    });
    return flushTail;
  }

  return {
    async load(): Promise<void> {
      const user = signals.$currentUser.value;
      if (user === null) return;
      try {
        signals.$outbox.value = await deps.storage.listEntries(user.userId);
      } catch (err) {
        console.warn('[outbox] could not read the stored entries:', err);
      }
    },

    async capture(input): Promise<void> {
      const user = signals.$currentUser.value;
      if (user === null) return;
      const entry: OutboxEntry = {
        clientId: deps.newClientId(),
        userId: user.userId,
        title: input.title,
        parentId: input.parentId,
        createdAt: deps.now(),
      };
      signals.$outbox.value = [...signals.$outbox.value, entry];
      try {
        // Before anything is sent. If the tab dies during the request, the
        // entry is what is left.
        await deps.storage.putEntry(entry);
      } catch (err) {
        // Private mode, or a full disk. The capture still goes out and still
        // retries for as long as this tab lives; it will not survive a reload.
        console.warn('[outbox] could not store the entry; it will not survive a reload:', err);
      }
      await flush();
    },

    flush,

    reconcile(tasks): void {
      for (const task of tasks) {
        if (task.clientId === null || !isQueued(task.clientId)) continue;
        forget(task.clientId);
        void deleteStored(task.clientId);
      }
    },

    armSnapshot(): void {
      snapshotArmed = true;
    },

    async saveSnapshot(): Promise<void> {
      const user = signals.$currentUser.value;
      // Unarmed, the list is either empty or itself the copy: writing it back
      // would replace a good copy with nothing on every boot.
      if (user === null || !snapshotArmed) return;
      if (snapshotWriting) {
        snapshotDirty = true;
        return;
      }
      snapshotWriting = true;
      try {
        // Latest wins: however many changes land during a write, one more
        // write follows it, carrying the newest list.
        do {
          snapshotDirty = false;
          await deps.storage.putSnapshot(user.userId, [...signals.$tasksById.value.values()]);
        } while (snapshotDirty);
      } catch (err) {
        console.warn('[outbox] could not store the list copy:', err);
      } finally {
        snapshotWriting = false;
      }
    },

    async restoreSnapshot(): Promise<boolean> {
      const user = signals.$currentUser.value;
      if (user === null || signals.$tasksById.value.size > 0) return false;
      try {
        const tasks = await deps.storage.getSnapshot(user.userId);
        if (tasks === null) return false;
        const next = new Map<number, Task>();
        for (const task of tasks) next.set(task.id, task);
        signals.$tasksById.value = next;
        return true;
      } catch (err) {
        console.warn('[outbox] could not read the list copy:', err);
        return false;
      }
    },

    async clear(): Promise<number> {
      const discarded = signals.$outbox.value.length;
      signals.$outbox.value = [];
      snapshotArmed = false;
      try {
        await deps.storage.clear();
      } catch (err) {
        console.warn('[outbox] could not clear the offline stores:', err);
      }
      return discarded;
    },
  };
}
