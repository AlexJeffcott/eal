/**
 * Adapter over the browser's AudioContext constructor.
 *
 * Production code imports this module instead of touching the global
 * directly. Tests swap the export via `mock.module('.../audio-context.ts',
 * () => ({ AudioContext: SpyClass }))` and the consuming code picks up
 * the spy without any DI plumbing.
 *
 * Re-exports for consumers:
 *   - `AudioContext` — the browser ctor, or `null` if the platform
 *     does not implement Web Audio (Node, very old Safari at narrow
 *     viewports). Consumers handle the null case where it matters;
 *     for the few places that always run in a real browser, asserting
 *     non-null at the call site is fine.
 */

export const AudioContext: typeof globalThis.AudioContext | null =
  typeof globalThis.AudioContext === 'undefined' ? null : globalThis.AudioContext;
