/**
 * The browser half of the capture outbox — see outbox.ts for what is stored and
 * why. This file is everything outbox.ts has injected: IndexedDB, Web Locks,
 * `crypto.randomUUID` and the clock. Two object stores in one database:
 *
 *   outbox    keyed on `clientId`    one row per capture not yet confirmed
 *   snapshot  keyed on the user id   the last task list the server sent
 *
 * Every read validates the shape it gets back. IndexedDB is a store the user,
 * an extension or an older build of this app can have written to, and a row
 * that is not an entry is dropped rather than rendered.
 */
import type { EalClient, Task } from '@eal/client';
import { indexedDB } from '../../platform/indexed-db.ts';
import { locks } from '../../platform/locks.ts';
import { friendlyTaskError } from './actions.ts';
import {
  createTaskOutbox,
  type OutboxEntry,
  type OutboxSignals,
  type OutboxStorage,
  type TaskOutbox,
  withKnownRecurrence,
} from './outbox.ts';

const DB_NAME = 'eal-tasks-offline';
const DB_VERSION = 1;
const OUTBOX = 'outbox';
const SNAPSHOT = 'snapshot';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (indexedDB === null) {
      reject(new Error('indexedDB is not supported on this platform'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'clientId' });
      if (!db.objectStoreNames.contains(SNAPSHOT)) db.createObjectStore(SNAPSHOT);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

/** Run one transaction and resolve with `read`'s result once it has committed. */
async function inTransaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => IDBRequest<T> | null,
): Promise<T | null> {
  const db = await openDb();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const req = work(tx);
      // Resolve on `complete`, not on the request's `success`: a write is not
      // durable until its transaction commits, and "written before it is sent"
      // is the whole promise this module makes.
      tx.oncomplete = () => resolve(req === null ? null : req.result);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

function isEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'clientId' in value && typeof value.clientId === 'string' &&
    'userId' in value && typeof value.userId === 'number' &&
    'title' in value && typeof value.title === 'string' &&
    'parentId' in value && (value.parentId === null || typeof value.parentId === 'number') &&
    'createdAt' in value && typeof value.createdAt === 'string'
  );
}

/**
 * Enough of `Task` to render and to reconcile by. The list is replaced by the
 * server's the moment a seed succeeds, so a field this does not check can be
 * wrong for the length of an outage and no longer.
 */
function isTask(value: unknown): value is Task {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'id' in value && typeof value.id === 'number' &&
    'title' in value && typeof value.title === 'string' &&
    'status' in value && typeof value.status === 'string' &&
    'kind' in value && typeof value.kind === 'string' &&
    'position' in value && typeof value.position === 'number' &&
    'clientId' in value && (value.clientId === null || typeof value.clientId === 'string')
  );
}

export const idbOutboxStorage: OutboxStorage = {
  async putEntry(entry): Promise<void> {
    await inTransaction([OUTBOX], 'readwrite', (tx) => tx.objectStore(OUTBOX).put(entry));
  },

  async deleteEntry(clientId): Promise<void> {
    await inTransaction([OUTBOX], 'readwrite', (tx) => tx.objectStore(OUTBOX).delete(clientId));
  },

  async listEntries(userId): Promise<OutboxEntry[]> {
    const all = await inTransaction<unknown[]>([OUTBOX], 'readonly', (tx) =>
      tx.objectStore(OUTBOX).getAll(),
    );
    return (all ?? [])
      .filter(isEntry)
      .filter((entry) => entry.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async putSnapshot(userId, tasks): Promise<void> {
    await inTransaction([SNAPSHOT], 'readwrite', (tx) =>
      tx.objectStore(SNAPSHOT).put([...tasks], userId),
    );
  },

  async getSnapshot(userId): Promise<Task[] | null> {
    const stored = await inTransaction<unknown>([SNAPSHOT], 'readonly', (tx) =>
      tx.objectStore(SNAPSHOT).get(userId),
    );
    if (!Array.isArray(stored)) return null;
    return stored.filter(isTask).map(withKnownRecurrence);
  },

  async clear(): Promise<void> {
    await inTransaction([OUTBOX, SNAPSHOT], 'readwrite', (tx) => {
      tx.objectStore(OUTBOX).clear();
      tx.objectStore(SNAPSHOT).clear();
      return null;
    });
  },
};

/** The outbox as the running app builds it (web/src/stores.ts). */
export function createBrowserTaskOutbox(client: EalClient, signals: OutboxSignals): TaskOutbox {
  return createTaskOutbox(
    {
      client,
      storage: idbOutboxStorage,
      locks,
      newClientId: () => crypto.randomUUID(),
      now: () => new Date().toISOString(),
      describeError: friendlyTaskError,
    },
    signals,
  );
}
