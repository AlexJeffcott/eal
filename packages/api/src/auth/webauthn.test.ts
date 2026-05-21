import { describe, expect, test } from 'bun:test';
import { createChallengeStore } from './challenges.ts';
import { decodeUserHandle, encodeUserHandle, isCounterRollback } from './webauthn.ts';

describe('encodeUserHandle / decodeUserHandle', () => {
  test('round-trips a typical user id', () => {
    const bytes = encodeUserHandle(42);
    expect(decodeUserHandle(bytes)).toBe(42);
  });

  test('round-trips a large id', () => {
    const id = 9_999_999;
    expect(decodeUserHandle(encodeUserHandle(id))).toBe(id);
  });

  test('rejects empty handle', () => {
    expect(decodeUserHandle(new Uint8Array(0))).toBeNull();
  });

  test('rejects non-numeric handle', () => {
    expect(decodeUserHandle(new TextEncoder().encode('not-a-number'))).toBeNull();
  });

  test('rejects negative or zero ids', () => {
    expect(decodeUserHandle(new TextEncoder().encode('0'))).toBeNull();
    expect(decodeUserHandle(new TextEncoder().encode('-5'))).toBeNull();
  });

  test('rejects fractional ids', () => {
    expect(decodeUserHandle(new TextEncoder().encode('1.5'))).toBeNull();
  });

  test('accepts the string overload', () => {
    expect(decodeUserHandle('42')).toBe(42);
  });
});

describe('isCounterRollback', () => {
  test('strict monotonic increase is allowed', () => {
    expect(isCounterRollback(5, 6)).toBe(false);
    expect(isCounterRollback(0, 1)).toBe(false);
  });

  test('equal counter is a replay', () => {
    expect(isCounterRollback(5, 5)).toBe(true);
  });

  test('decreasing counter is a replay', () => {
    expect(isCounterRollback(10, 3)).toBe(true);
  });

  test('0/0 is allowed (authenticators that never increment)', () => {
    expect(isCounterRollback(0, 0)).toBe(false);
  });
});

describe('ChallengeStore', () => {
  test('set then take returns the entry exactly once', () => {
    const store = createChallengeStore();
    store.set('ch1', { kind: 'register', meta: { displayName: 'alex' } });
    const entry = store.take('ch1');
    expect(entry?.kind).toBe('register');
    expect(entry?.meta?.['displayName']).toBe('alex');
    expect(store.take('ch1')).toBeNull();
  });

  test('take after expiry returns null', () => {
    let nowMs = 1_000_000;
    const store = createChallengeStore({ now: () => nowMs, defaultTtlMs: 1_000 });
    store.set('ch1', { kind: 'register' });
    nowMs += 5_000;
    expect(store.take('ch1')).toBeNull();
  });

  test('take of unknown challenge returns null', () => {
    const store = createChallengeStore();
    expect(store.take('unknown')).toBeNull();
  });

  test('pruneExpired removes only expired entries', () => {
    let nowMs = 1_000_000;
    const store = createChallengeStore({ now: () => nowMs, defaultTtlMs: 1_000 });
    store.set('short', { kind: 'register' }, 500);
    store.set('long', { kind: 'authenticate' }, 10_000);
    nowMs += 2_000;
    expect(store.pruneExpired()).toBe(1);
    expect(store.size()).toBe(1);
    expect(store.take('long')?.kind).toBe('authenticate');
  });

  test('custom ttl overrides default', () => {
    let nowMs = 0;
    const store = createChallengeStore({ now: () => nowMs, defaultTtlMs: 1_000 });
    store.set('short', { kind: 'register' });
    store.set('long', { kind: 'register' }, 60_000);
    nowMs = 5_000;
    expect(store.take('short')).toBeNull();
    expect(store.take('long')?.kind).toBe('register');
  });
});
