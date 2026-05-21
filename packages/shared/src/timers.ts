/**
 * timers — eal's deterministic wait primitives.
 *
 * Fixed-duration sleeps — `await new Promise((r) => setTimeout(r, n))` — are
 * banned across the codebase. `scripts/check-no-fixed-waits.ts` enforces it.
 * A fixed sleep guesses how long an operation takes: too short and the test
 * flakes on a loaded machine, too long and every run wastes that time. The
 * guess is never right, only un-noticed.
 *
 * This file is the single sanctioned home for timer-backed waiting. Three
 * primitives, each for a distinct intent:
 *
 * - `pollUntil(condition, opts)` — wait for something to become true. Re-checks
 *   a real condition on an interval and resolves the instant it holds. The
 *   delay is a poll cadence, never an assumption about completion. This is the
 *   one blessed timer-based wait.
 * - `flushMicrotasks()` — let an already-scheduled promise chain settle. No
 *   timer at all: it yields exactly one microtask turn, so it is precise, not
 *   a guess. The test-side replacement for a tiny "give it a moment" sleep.
 * - `delay(ms)` — the one sanctioned fixed delay. Legal ONLY where the wait
 *   itself is the intended behaviour: retry/reconnect backoff, the cadence
 *   between polls of an external service. Never to "give the code a moment".
 */

/** Options for {@link pollUntil}. */
export interface PollOptions {
  /** Delay between attempts, in ms. */
  intervalMs: number;
  /** Maximum total time to wait before rejecting, in ms. */
  timeoutMs: number;
  /** Human-readable name of what is awaited, used in the timeout message. */
  label?: string;
}

/**
 * Polls `condition` until it returns a truthy value, then resolves with it.
 * Rejects if `timeoutMs` elapses first, or if `condition` itself throws.
 *
 * Replaces a fixed sleep with an explicit success criterion: the wait ends the
 * moment the condition holds. The recursive `setTimeout(attempt, ...)` is the
 * poll cadence — its callback does real work (re-evaluating the condition),
 * which is what separates a poll from a sleep.
 */
export function pollUntil<T>(
  condition: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  { intervalMs, timeoutMs, label = 'condition' }: PollOptions,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  return new Promise<T>((resolve, reject) => {
    const attempt = async (): Promise<void> => {
      let result: T | null | undefined | false;
      try {
        result = await condition();
      } catch (error) {
        reject(error);
        return;
      }

      if (result) {
        resolve(result);
        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error(`pollUntil: timed out after ${timeoutMs}ms waiting for ${label}`));
        return;
      }

      setTimeout(attempt, intervalMs);
    };

    void attempt();
  });
}

/**
 * Yields once to the microtask queue so pending promise callbacks run.
 *
 * For tests: after an already-resolved promise, the `.then` callbacks it
 * schedules still need one microtask turn to run. Awaiting this guarantees
 * those callbacks have executed before the next assertion — exactly, with no
 * timer and so no flake and no wasted wall-clock time.
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(resolve);
  });
}

/**
 * Resolves after `ms` milliseconds. The single sanctioned fixed delay.
 *
 * Use ONLY where the wait itself is the intended behaviour and there is
 * genuinely no condition to observe — retry/reconnect backoff, the cadence
 * between polls of an external service. To wait *for* something to become
 * true, use {@link pollUntil}; to let a promise chain settle in a test, use
 * {@link flushMicrotasks}.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
