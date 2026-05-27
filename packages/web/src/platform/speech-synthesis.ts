/**
 * Adapter over the browser's Web Speech API (SpeechSynthesis).
 *
 * Production code imports this module instead of touching the globals
 * directly. Tests swap the export via `mock.module('.../speech-
 * synthesis.ts', () => ({ speechSynthesis: spy, SpeechSynthesisUtterance:
 * SpyCtor }))` and the consuming code picks up the spy without any DI
 * plumbing.
 *
 * Exports:
 *   - `speechSynthesis` — the live SpeechSynthesis instance, or `null`
 *     on platforms (Node test runners, older browsers) that don't
 *     implement the API.
 *   - `SpeechSynthesisUtterance` — the matching ctor, or `null` on the
 *     same platforms.
 */

export const speechSynthesis: SpeechSynthesis | null =
  typeof globalThis.speechSynthesis === 'undefined' ? null : globalThis.speechSynthesis;

export const SpeechSynthesisUtterance: typeof globalThis.SpeechSynthesisUtterance | null =
  typeof globalThis.SpeechSynthesisUtterance === 'undefined'
    ? null
    : globalThis.SpeechSynthesisUtterance;
