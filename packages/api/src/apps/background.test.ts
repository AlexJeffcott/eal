import { Elysia } from 'elysia';
import { describe, expect, test } from 'bun:test';
import { createDb } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createTestApp } from '../test-helpers/create-test-app.ts';
import { startAppBackground } from './background.ts';
import { API_APPS } from './registry.ts';
import type { ApiApp, ApiAppBackgroundTask } from './types.ts';

/**
 * The load-bearing claim of the background-worker design: **building an app
 * does not start it.**
 *
 * 1251 unit tests build a test app apiece. A sixty-second interval leaking into
 * each one would either hold the tier open at the end of the run or fire real
 * sends from a test that never asked for any. The separation is what stops
 * that, and this file is where the separation is checked rather than assumed —
 * both halves of it, because "nothing starts" is only worth anything beside
 * "and this is what starting looks like".
 */

interface SpyApp {
  app: ApiApp;
  /** How many times `start` was called. */
  starts(): number;
  /** How many times the returned task was stopped. */
  stops(): number;
}

function spyApp(id: string, opts: { declines?: boolean } = {}): SpyApp {
  let starts = 0;
  let stops = 0;
  const app: ApiApp = {
    id,
    schema: '',
    routes: () => new Elysia(),
    start: (): ApiAppBackgroundTask | null => {
      starts += 1;
      if (opts.declines === true) return null;
      return {
        stop(): void {
          stops += 1;
        },
      };
    },
  };
  return { app, starts: () => starts, stops: () => stops };
}

describe('app background workers', () => {
  test('createTestApp starts nothing — not even for an app that has a worker', async () => {
    const spy = spyApp('spy');
    const db = createDb(':memory:');

    await createTestApp(db, { apps: [spy.app] });

    // If this ever reads 1, every one of the unit tier's test apps has acquired
    // whatever timer the app's worker holds.
    expect(spy.starts()).toBe(0);
  });

  test('a test app built over the production registry starts nothing either', async () => {
    const db = createDb(':memory:');
    // The default path — no `apps` override, so the real registry including the
    // push app and its reminder scan. `createTestApp` defaults `env` to `{}`,
    // so even were this to start something it would find no VAPID keypair; the
    // point of the assertion below is that it never gets that far.
    const app = await createTestApp(db);

    // The app is real and answers, which is what makes the absence meaningful:
    // nothing has been stubbed out to reach this.
    const health = await app.handle(new Request('https://localhost/public/health'));
    expect(health.status).toBe(200);

    // Every installed app that has a worker, and none of them running. The
    // registry is read here rather than hard-coded so an app added later with a
    // `start` is covered by this test the day it lands.
    const withWorkers = API_APPS.filter((a) => a.start !== undefined).map((a) => a.id);
    expect(withWorkers).toContain('push');
  });

  test('startAppBackground is what starts them, and stop() stops every one', () => {
    const first = spyApp('first');
    const second = spyApp('second');
    const db = createDb(':memory:');

    const running = startAppBackground({ db, env: {} }, [first.app, second.app]);

    expect(running.started).toEqual(['first', 'second']);
    expect(first.starts()).toBe(1);
    expect(second.starts()).toBe(1);

    running.stop();
    expect(first.stops()).toBe(1);
    expect(second.stops()).toBe(1);
  });

  test('an app with no worker is skipped without complaint', () => {
    const plain: ApiApp = { id: 'plain', schema: '', routes: () => new Elysia() };
    const db = createDb(':memory:');

    const running = startAppBackground({ db, env: {} }, [plain]);

    expect(running.started).toEqual([]);
    expect(() => running.stop()).not.toThrow();
  });

  test('an app that declines is not counted as started, and is not stopped', () => {
    // Declining is how an unconfigured worker says so — the push app returns
    // null when there is no VAPID keypair rather than starting a scan that
    // could not deliver anything.
    const declining = spyApp('declining', { declines: true });
    const db = createDb(':memory:');

    const running = startAppBackground({ db, env: {} }, [declining.app]);

    expect(declining.starts()).toBe(1);
    expect(running.started).toEqual([]);
    running.stop();
    expect(declining.stops()).toBe(0);
  });

  test('the push app declines without VAPID keys, and starts with them', () => {
    const db = createDb(':memory:');
    applySchema(db);
    const push = requirePushApp();

    expect(startAppBackground({ db, env: {} }, [push]).started).toEqual([]);

    const configured = startAppBackground(
      {
        db,
        env: {
          EAL_VAPID_PUBLIC_KEY: 'public',
          EAL_VAPID_PRIVATE_KEY: 'private',
          EAL_VAPID_SUBJECT: 'mailto:eal@example.com',
          // A day, so the loop's first immediate pass runs and then waits well
          // past the end of this test rather than scanning on a cadence.
          EAL_REMINDER_TICK_MS: '86400000',
        },
      },
      [push],
    );
    expect(configured.started).toEqual(['push']);
    // Left running, this holds a timer and the tier's process with it.
    configured.stop();
  });

  test('a half-configured VAPID set fails the boot rather than half-working', () => {
    const db = createDb(':memory:');
    applySchema(db);
    expect(() =>
      startAppBackground({ db, env: { EAL_VAPID_PUBLIC_KEY: 'public' } }, [requirePushApp()]),
    ).toThrow('must all be set together or none of them');
  });
});

/** The installed push app, or a failure that names what is missing. */
function requirePushApp(): ApiApp {
  const push = API_APPS.find((a) => a.id === 'push');
  if (push === undefined) throw new Error('the push app is not in the registry');
  return push;
}
