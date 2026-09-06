import { describe, expect, test } from 'bun:test';
import { createStoppableDelay, delay, flushMicrotasks, pollUntil } from './timers.ts';

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

  test('uses the default label in the timeout message when no label is supplied', async () => {
    await expect(
      pollUntil(() => false, { intervalMs: 1, timeoutMs: 20 }),
    ).rejects.toThrow('waiting for condition');
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

describe('createStoppableDelay', () => {
  test('waits like delay when it is not stopped', async () => {
    const cadence = createStoppableDelay();
    const start = Date.now();
    await cadence.wait(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(cadence.stopped).toBe(false);
  });

  test('stop() resolves a wait in flight without waiting it out', async () => {
    const cadence = createStoppableDelay();
    const start = Date.now();
    // An hour. If stop() did not resolve it, this test would never finish —
    // which is exactly the hang this primitive exists to prevent.
    const waiting = cadence.wait(3_600_000);
    cadence.stop();
    await waiting;
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(cadence.stopped).toBe(true);
  });

  test('resolves every wait in flight, not just the first', async () => {
    const cadence = createStoppableDelay();
    const all = Promise.all([cadence.wait(3_600_000), cadence.wait(3_600_000)]);
    cadence.stop();
    await all;
    expect(cadence.stopped).toBe(true);
  });

  test('a wait started after stop() is already resolved', async () => {
    const cadence = createStoppableDelay();
    cadence.stop();
    const start = Date.now();
    await cadence.wait(3_600_000);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test('stop() is idempotent', async () => {
    const cadence = createStoppableDelay();
    const waiting = cadence.wait(3_600_000);
    cadence.stop();
    cadence.stop();
    await waiting;
    expect(cadence.stopped).toBe(true);
  });

  test('a wait that completes on its own stops being tracked', async () => {
    const cadence = createStoppableDelay();
    await cadence.wait(1);
    // Nothing left to release. stop() must not throw on an empty set, which is
    // the ordinary shutdown after a loop has just finished a pass.
    expect(() => cadence.stop()).not.toThrow();
  });
});
