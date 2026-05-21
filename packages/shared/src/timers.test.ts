import { describe, expect, test } from 'bun:test';
import { delay, flushMicrotasks, pollUntil } from './timers.ts';

describe('delay', () => {
  test('resolves no sooner than the requested time', async () => {
    const start = Date.now();
    await delay(20);
    // Lower bound only — asserting an upper bound would itself be flaky.
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe('flushMicrotasks', () => {
  test('lets an already-scheduled promise callback run before resolving', async () => {
    let ran = false;
    void Promise.resolve().then(() => {
      ran = true;
    });
    // The `.then` callback is queued but has not run yet.
    expect(ran).toBe(false);
    await flushMicrotasks();
    expect(ran).toBe(true);
  });
});

describe('pollUntil', () => {
  test('resolves with the value once the condition holds', async () => {
    let calls = 0;
    const value = await pollUntil(
      () => {
        calls += 1;
        return calls >= 3 ? 'ready' : null;
      },
      { intervalMs: 1, timeoutMs: 1000 },
    );
    expect(value).toBe('ready');
    expect(calls).toBe(3);
  });

  test('awaits async conditions', async () => {
    let calls = 0;
    const value = await pollUntil(
      async () => {
        calls += 1;
        return calls >= 2 ? 42 : undefined;
      },
      { intervalMs: 1, timeoutMs: 1000 },
    );
    expect(value).toBe(42);
  });

  test('rejects with a descriptive error when the deadline passes', async () => {
    await expect(
      pollUntil(() => false, { intervalMs: 1, timeoutMs: 20, label: 'the impossible' }),
    ).rejects.toThrow('pollUntil: timed out after 20ms waiting for the impossible');
  });

  test('rejects if the condition itself throws', async () => {
    await expect(
      pollUntil(
        () => {
          throw new Error('boom');
        },
        { intervalMs: 1, timeoutMs: 1000 },
      ),
    ).rejects.toThrow('boom');
  });
});
