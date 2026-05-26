/**
 * Adapter over the browser's Notification API.
 *
 * Production code imports this module instead of touching the global
 * directly. Tests swap the export via `mock.module('.../notification.ts',
 * () => ({ Notification: SpyClass }))` and the consuming code picks up
 * the spy without any DI plumbing.
 *
 * Exports:
 *   - `Notification` — the browser ctor + static API, or `null` on
 *     platforms that don't implement Notifications at all.
 */

export const Notification: typeof globalThis.Notification | null =
  typeof globalThis.Notification === 'undefined' ? null : globalThis.Notification;
