import webpush from 'web-push';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import { createFamilyPhonePushSubscriptionsRepo } from '../db/repos/family-phone-push-subscriptions.ts';
import { loadPushVapidConfig } from './push.http.ts';
import type { DatabaseClient } from '../db/client.ts';

/**
 * Best-effort Web Push wake for a call:invite whose target isn't on the
 * WS. Pulled out of `family-phone.ws.ts` so the WS file's coverage doesn't
 * sag under the weight of a vendor-bound side-channel that's hard to
 * exercise in unit tests. The WS handler injects this into the router as
 * its `onCallInviteOfflineTarget` callback.
 *
 * Caller's UI still gets `call:invite-failed`/reason `target-offline` —
 * the wake is purely so the recipient's phone buzzes and the human can
 * open the app and call back.
 */

/**
 * web-push throws errors carrying a `statusCode` field on vendor
 * responses. Read it defensively without casting — `unknown` flows
 * through structural narrowing.
 */
function readWebPushStatusCode(err: unknown): number {
  if (typeof err !== 'object' || err === null) return 0;
  if (!('statusCode' in err)) return 0;
  const candidate = err.statusCode;
  return typeof candidate === 'number' ? candidate : 0;
}

export type FireOfflineCallWake = (
  targetDeviceId: number,
  callerDeviceId: number,
) => Promise<void>;

export function createFireOfflineCallWake(db: DatabaseClient): FireOfflineCallWake {
  const pushSubs = createFamilyPhonePushSubscriptionsRepo(db);
  const devicesRepo = createFamilyPhoneDevicesRepo(db);
  // VAPID config is read once when the handler boots. Calling
  // sendNotification when this is null is wasted work — the
  // module-global webpush.setVapidDetails was skipped at boot, so
  // every call would throw. Guard the offline-wake branch on it.
  const vapid = loadPushVapidConfig();

  return async function fireOfflineCallWake(targetDeviceId, callerDeviceId) {
    if (!vapid) return;
    const targets = pushSubs.listByDevice(targetDeviceId);
    if (targets.length === 0) return;
    const callerDevice = devicesRepo.findById(callerDeviceId);
    const callerLabel = callerDevice?.label ?? 'Someone';
    const payload = JSON.stringify({
      kind: 'call',
      title: 'Incoming call',
      body: `From ${callerLabel}`,
      // Coalesce multiple invites from the same caller — repeated
      // dials should re-buzz the OS (renotify: true in the SW) but
      // not stack on the lock screen.
      tag: `call:${callerDeviceId}`,
      url: '/devices',
    });
    await Promise.all(
      targets.map(async (t) => {
        try {
          await webpush.sendNotification(
            { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
            payload,
            { TTL: 30 },
          );
        } catch (err) {
          const statusCode = readWebPushStatusCode(err);
          if (statusCode === 404 || statusCode === 410) {
            // The subscription is dead. Clear it so future invites
            // don't waste a round trip on a vendor that will reject
            // every time.
            pushSubs.deleteByEndpoint(t.endpoint);
          } else {
            console.warn('[push] call-wake send failed:', err);
          }
        }
      }),
    );
  };
}
