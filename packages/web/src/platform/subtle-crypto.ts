/**
 * Adapter over the browser's SubtleCrypto interface.
 *
 * Production code imports `subtleCrypto` instead of reaching for
 * `crypto.subtle` directly. Tests swap the export via
 * `mock.module('.../subtle-crypto.ts', () => ({ subtleCrypto: stub }))`
 * and assert generateKey / sign / verify were invoked with the right
 * algorithm parameters without depending on a real crypto backend.
 */
const candidate =
  typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined'
    ? crypto.subtle
    : null;
export const subtleCrypto: SubtleCrypto | null = candidate;
