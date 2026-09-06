import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createPushSubscriptionsRepo } from '../db/repos/push-subscriptions.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { loadPushVapidConfig, pushHttpRoutes, pushSubscriptionRoutes } from './push.http.ts';
import type { Principal } from '../auth/principals.ts';

const VAR_KEYS = ['EAL_VAPID_PUBLIC_KEY', 'EAL_VAPID_PRIVATE_KEY', 'EAL_VAPID_SUBJECT'] as const;

describe('loadPushVapidConfig', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of VAR_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of VAR_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('returns null when none of the three vars are set', () => {
    expect(loadPushVapidConfig()).toBeNull();
  });

  test('returns config when all three vars are set with a mailto subject', () => {
    process.env['EAL_VAPID_PUBLIC_KEY'] = 'pubkey';
    process.env['EAL_VAPID_PRIVATE_KEY'] = 'privkey';
    process.env['EAL_VAPID_SUBJECT'] = 'mailto:test@example.com';
    const cfg = loadPushVapidConfig();
    expect(cfg).toEqual({
      publicKey: 'pubkey',
      privateKey: 'privkey',
      subject: 'mailto:test@example.com',
    });
  });

  test('accepts an https:// subject', () => {
    process.env['EAL_VAPID_PUBLIC_KEY'] = 'pub';
    process.env['EAL_VAPID_PRIVATE_KEY'] = 'priv';
    process.env['EAL_VAPID_SUBJECT'] = 'https://example.com/contact';
    expect(loadPushVapidConfig()?.subject).toBe('https://example.com/contact');
  });

  test('throws when only one or two of the vars are set', () => {
    process.env['EAL_VAPID_PUBLIC_KEY'] = 'pub';
    expect(() => loadPushVapidConfig()).toThrow(/must all be set together/);

    process.env['EAL_VAPID_PRIVATE_KEY'] = 'priv';
    expect(() => loadPushVapidConfig()).toThrow(/must all be set together/);
  });

  test('throws on a subject that is neither mailto: nor https://', () => {
    process.env['EAL_VAPID_PUBLIC_KEY'] = 'pub';
    process.env['EAL_VAPID_PRIVATE_KEY'] = 'priv';
    process.env['EAL_VAPID_SUBJECT'] = 'http://insecure.example';
    expect(() => loadPushVapidConfig()).toThrow(/must start with "mailto:"/);
  });

  test('treats whitespace-only values as unset', () => {
    process.env['EAL_VAPID_PUBLIC_KEY'] = '   ';
    process.env['EAL_VAPID_PRIVATE_KEY'] = '   ';
    process.env['EAL_VAPID_SUBJECT'] = '   ';
    expect(loadPushVapidConfig()).toBeNull();
  });
});

describe('pushHttpRoutes /public/push/vapid-public-key', () => {
  test('returns the configured public key with hour-long cache', async () => {
    const app = pushHttpRoutes({
      vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:test@example.com' },
    });
    const res = await app.handle(new Request('http://test/public/push/vapid-public-key'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await res.json();
    expect(body).toEqual({ publicKey: 'pub' });
  });

  test('returns 503 when VAPID is not configured', async () => {
    const app = pushHttpRoutes({ vapid: null });
    const res = await app.handle(new Request('http://test/public/push/vapid-public-key'));
    expect(res.status).toBe(503);
  });
});

describe('loadPushVapidConfig, from an explicit environment', () => {
  test('reads the environment it is handed rather than process.env', () => {
    // What an app does with `ApiAppContext.env` — the same reason family-phone
    // takes its trunk config that way rather than reaching for the process one.
    expect(
      loadPushVapidConfig({
        EAL_VAPID_PUBLIC_KEY: 'pub',
        EAL_VAPID_PRIVATE_KEY: 'priv',
        EAL_VAPID_SUBJECT: 'mailto:eal@example.com',
      }),
    ).toEqual({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:eal@example.com',
    });
    expect(loadPushVapidConfig({})).toBeNull();
  });
});

describe('the subscribe / unsubscribe routes', () => {
  let db: DatabaseClient;
  let alex: Principal;
  let elisa: Principal;
  let principal: Principal | null;

  function routes() {
    return pushSubscriptionRoutes({ db, getPrincipal: () => principal });
  }

  function post(path: string, body: unknown): Request {
    return new Request(`https://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const SUB = {
    endpoint: 'https://vendor.example/push/abc',
    p256dh: 'a-public-key',
    auth: 'an-auth-secret',
  };

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const users = createUsersRepo(db);
    alex = { userId: users.insert({ displayName: 'alex' }).id, displayName: 'alex' };
    elisa = { userId: users.insert({ displayName: 'elisa' }).id, displayName: 'elisa' };
    principal = alex;
  });

  test('subscribe files the browser against the signed-in person', async () => {
    const res = await routes().handle(post('/api/v1/push/subscribe', SUB));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subscription: { endpoint: SUB.endpoint, createdAt: expect.any(String) },
    });

    const stored = createPushSubscriptionsRepo(db).listByUser(alex.userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.p256dh).toBe('a-public-key');
  });

  test('subscribing twice from the same browser stores one row', async () => {
    await routes().handle(post('/api/v1/push/subscribe', SUB));
    await routes().handle(post('/api/v1/push/subscribe', SUB));
    expect(createPushSubscriptionsRepo(db).listAll()).toHaveLength(1);
  });

  test('a second person on the same browser takes the subscription over', async () => {
    await routes().handle(post('/api/v1/push/subscribe', SUB));
    principal = elisa;
    await routes().handle(post('/api/v1/push/subscribe', SUB));

    expect(createPushSubscriptionsRepo(db).listByUser(alex.userId)).toEqual([]);
    expect(createPushSubscriptionsRepo(db).listByUser(elisa.userId)).toHaveLength(1);
  });

  test('unsubscribe forgets the endpoint, and says whether it had one', async () => {
    await routes().handle(post('/api/v1/push/subscribe', SUB));

    const first = await routes().handle(
      post('/api/v1/push/unsubscribe', { endpoint: SUB.endpoint }),
    );
    expect(await first.json()).toEqual({ removed: true });

    // The idempotent second call — what a browser that unsubscribes twice does.
    const second = await routes().handle(
      post('/api/v1/push/unsubscribe', { endpoint: SUB.endpoint }),
    );
    expect(await second.json()).toEqual({ removed: false });
    expect(createPushSubscriptionsRepo(db).listAll()).toEqual([]);
  });

  test('both routes refuse an unauthenticated caller with a 401 envelope', async () => {
    principal = null;
    const subscribe = await routes().handle(post('/api/v1/push/subscribe', SUB));
    expect(subscribe.status).toBe(401);
    expect(await subscribe.json()).toEqual({ error: 'unauthenticated' });

    const unsubscribe = await routes().handle(
      post('/api/v1/push/unsubscribe', { endpoint: SUB.endpoint }),
    );
    expect(unsubscribe.status).toBe(401);
  });

  test('a missing half of the triple is a 400 that names the field', async () => {
    for (const field of ['endpoint', 'p256dh', 'auth'] as const) {
      const body = { ...SUB, [field]: '   ' };
      const res = await routes().handle(post('/api/v1/push/subscribe', body));
      expect(res.status).toBe(400);
      // Named, not a flattened 500: the browser needs to read which half it
      // failed to send.
      expect(await res.json()).toEqual({ error: `${field} is required` });
    }
  });

  test('subscribe works with no VAPID keypair configured', async () => {
    // A subscription stored while the keys are unset is a row waiting for a
    // deploy, not a half-working feature. Refusing it would mean re-tapping
    // every browser after the keys were set. Delivery is what the keys gate.
    const res = await routes().handle(post('/api/v1/push/subscribe', SUB));
    expect(res.status).toBe(200);
  });
});
