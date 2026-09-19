/**
 * Adapter over the Web Locks API.
 *
 * Production code imports this module instead of touching `navigator.locks`
 * directly, the same way `indexed-db.ts` wraps its factory. `null` where the
 * browser has none — Safari before 15.4 — and the caller decides what that
 * costs it.
 */
export const locks: LockManager | null =
  typeof navigator === 'undefined' || !('locks' in navigator) ? null : navigator.locks;
