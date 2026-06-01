import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import webpush, { type SendResult } from 'web-push';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import { createFamilyPhonePushSubscriptionsRepo } from '../db/repos/family-phone-push-subscriptions.ts';
import { createFireOfflineCallWake } from './family-phone-call-wake.ts';

async function ok(): Promise<SendResult> {
  return { statusCode: 201, body: '', headers: {} };
}

/**
 * The offline-wake helper is best-effort glue around web-push and the
 * subscriptions repo. We swap webpush.sendNotification to capture sends
 * and synthesise vendor errors — the alternative (a real network) would
 * be a fixed-wait integration test.
 */

const VAPID_KEYS = ['EAL_VAPID_PUBLIC_KEY', 'EAL_VAPID_PRIVATE_KEY', 'EAL_VAPID_SUBJECT'] as const;

function setVapid(): void {
  process.env['EAL_VAPID_PUBLIC_KEY'] = 'pub';
  process.env['EAL_VAPID_PRIVATE_KEY'] = 'priv';
  process.env['EAL_VAPID_SUBJECT'] = 'mailto:t@e.com';
}

function clearVapid(): void {
  for (const k of VAPID_KEYS) delete process.env[k];
}

interface Fixture {
  db: DatabaseClient;
  toDeviceId: number;
  fromDeviceId: number;
}

function prep(): Fixture {
  const db = createDb(':memory:');
  applySchema(db);
  const user = createUsersRepo(db).insert({ displayName: 'alex' });
  const devs = createFamilyPhoneDevicesRepo(db);
  const fromDevice = devs.insert({ userId: user.id, label: 'caller', kind: 'pwa' });
  const toDevice = devs.insert({ userId: user.id, label: 'target', kind: 'handset' });
  return { db, toDeviceId: toDevice.id, fromDeviceId: fromDevice.id };
}

describe('family-phone-call-wake', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const savedSend = webpush.sendNotification;

  beforeEach(() => {
    for (const k of VAPID_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of VAPID_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    webpush.sendNotification = savedSend;
  });

  test('short-circuits when VAPID is unset (factory ran with no env)', async () => {
    clearVapid();
    const { db, toDeviceId, fromDeviceId } = prep();
    createFamilyPhonePushSubscriptionsRepo(db).upsert({
      deviceId: toDeviceId,
      endpoint: 'https://fcm.example/a',
      p256dh: 'p',
      auth: 'a',
    });
    let sent = 0;
    webpush.sendNotification = async () => {
      sent += 1;
      return ok();
    };

    const fire = createFireOfflineCallWake(db);
    await fire(toDeviceId, fromDeviceId);
    expect(sent).toBe(0);
  });

  test('short-circuits when the target has no registered subscriptions', async () => {
    setVapid();
    const { db, toDeviceId, fromDeviceId } = prep();
    let sent = 0;
    webpush.sendNotification = async () => {
      sent += 1;
      return ok();
    };

    const fire = createFireOfflineCallWake(db);
    await fire(toDeviceId, fromDeviceId);
    expect(sent).toBe(0);
  });

  test('sends one notification per subscription with the caller label embedded', async () => {
    setVapid();
    const { db, toDeviceId, fromDeviceId } = prep();
    const subs = createFamilyPhonePushSubscriptionsRepo(db);
    subs.upsert({ deviceId: toDeviceId, endpoint: 'https://a', p256dh: 'p1', auth: 'a1' });
    subs.upsert({ deviceId: toDeviceId, endpoint: 'https://b', p256dh: 'p2', auth: 'a2' });

    const captured: Array<{ endpoint: string; payload: string }> = [];
    webpush.sendNotification = async (sub, payload) => {
      if (typeof sub !== 'object' || sub === null || !('endpoint' in sub)) {
        throw new Error('unexpected sub shape');
      }
      const endpoint = sub.endpoint;
      captured.push({
        endpoint: typeof endpoint === 'string' ? endpoint : '',
        payload: typeof payload === 'string' ? payload : '',
      });
      return ok();
    };

    const fire = createFireOfflineCallWake(db);
    await fire(toDeviceId, fromDeviceId);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.payload).toContain('From caller');
    expect(captured[0]?.payload).toContain(`call:${fromDeviceId}`);
  });

  test('uses "Someone" when the caller device is unknown', async () => {
    setVapid();
    const { db, toDeviceId } = prep();
    createFamilyPhonePushSubscriptionsRepo(db).upsert({
      deviceId: toDeviceId,
      endpoint: 'https://a',
      p256dh: 'p',
      auth: 'a',
    });
    let body = '';
    webpush.sendNotification = async (_sub, payload) => {
      body = typeof payload === 'string' ? payload : '';
      return ok();
    };

    const fire = createFireOfflineCallWake(db);
    await fire(toDeviceId, 99999);
    expect(body).toContain('From Someone');
  });

  test('a 410 vendor response removes the dead subscription row', async () => {
    setVapid();
    const { db, toDeviceId, fromDeviceId } = prep();
    const subs = createFamilyPhonePushSubscriptionsRepo(db);
    subs.upsert({ deviceId: toDeviceId, endpoint: 'https://dead', p256dh: 'p', auth: 'a' });

    webpush.sendNotification = async () => {
      const err: { statusCode: number; message: string } = {
        statusCode: 410,
        message: 'gone',
      };
      throw err;
    };

    const fire = createFireOfflineCallWake(db);
    await fire(toDeviceId, fromDeviceId);
    expect(subs.listByDevice(toDeviceId)).toEqual([]);
  });

  test('a non-410 vendor error is swallowed and the row stays', async () => {
    setVapid();
    const { db, toDeviceId, fromDeviceId } = prep();
    const subs = createFamilyPhonePushSubscriptionsRepo(db);
    subs.upsert({ deviceId: toDeviceId, endpoint: 'https://busy', p256dh: 'p', auth: 'a' });

    webpush.sendNotification = async () => {
      throw new Error('connection reset');
    };

    const fire = createFireOfflineCallWake(db);
    await fire(toDeviceId, fromDeviceId);
    expect(subs.listByDevice(toDeviceId)).toHaveLength(1);
  });
});
