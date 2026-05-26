import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadPushVapidConfig, pushHttpRoutes } from './push.http.ts';

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
