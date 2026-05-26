/**
 * Adapter over the browser's AudioWorkletNode constructor.
 *
 * Production code imports this module instead of touching the global
 * directly. Tests swap the export via
 * `mock.module('.../audio-worklet-node.ts', () => ({ AudioWorkletNode: stub }))`
 * and assert port messaging without spinning up a real worklet.
 */
export const AudioWorkletNode: typeof globalThis.AudioWorkletNode | null =
  typeof globalThis.AudioWorkletNode === 'undefined' ? null : globalThis.AudioWorkletNode;
