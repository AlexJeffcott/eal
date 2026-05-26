/**
 * Adapter over the browser's IndexedDB factory.
 *
 * Production code imports this module instead of touching the global
 * directly. Tests swap the export via
 * `mock.module('.../indexed-db.ts', () => ({ indexedDB: ... }))` and
 * pass an in-memory shim (e.g. fake-indexeddb).
 */
export const indexedDB: typeof globalThis.indexedDB | null =
  typeof globalThis.indexedDB === 'undefined' ? null : globalThis.indexedDB;
