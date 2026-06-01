import { createFamilyPhoneChallengesRepo } from '../db/repos/family-phone-challenges.ts';
import { createFamilyPhoneDeviceKeysRepo } from '../db/repos/family-phone-device-keys.ts';
import {
  createFamilyPhonePushSubscriptionsRepo,
  type FamilyPhonePushSubscriptionsRepo,
} from '../db/repos/family-phone-push-subscriptions.ts';
import { createFamilyPhoneDeviceSessionsRepo } from '../db/repos/family-phone-device-sessions.ts';
import { authCore, defaultRandomToken } from './family-phone-device-auth.shared.ts';
import { AuthError } from './auth.shared.ts';
import { createCallRouter, type CallRouter } from './family-phone-call-router.ts';
import { createFireOfflineCallWake } from './family-phone-call-wake.ts';
import type { WsAppContext, WsLike, WsMessageHandler } from '../apps/types.ts';

/**
 * Parse a `{type: 'push:subscribe', endpoint, p256dh, auth}` envelope.
 * Returns the parsed fields or null on shape mismatch. No length or
 * format validation here — the vendor's `endpoint` strings vary in
 * shape across browsers and we want to accept whatever the SPA was
 * given by pushManager.subscribe.
 */
function readPushSubscribe(
  msg: unknown,
): { endpoint: string; p256dh: string; auth: string } | null {
  if (typeof msg !== 'object' || msg === null) return null;
  if (!('endpoint' in msg) || typeof msg.endpoint !== 'string') return null;
  if (!('p256dh' in msg) || typeof msg.p256dh !== 'string') return null;
  if (!('auth' in msg) || typeof msg.auth !== 'string') return null;
  return { endpoint: msg.endpoint, p256dh: msg.p256dh, auth: msg.auth };
}

function readPushUnsubscribe(msg: unknown): { endpoint: string } | null {
  if (typeof msg !== 'object' || msg === null) return null;
  if (!('endpoint' in msg) || typeof msg.endpoint !== 'string') return null;
  return { endpoint: msg.endpoint };
}

/**
 * Match an `{type: 'auth', device_id, nonce, signature}` envelope; return
 * the parsed fields or null. Validates types but not bytes (signature
 * verification is the next step).
 */
function readDeviceAuth(
  msg: unknown,
): { deviceId: number; nonce: string; signature: string } | null {
  if (typeof msg !== 'object' || msg === null) return null;
  if (!('device_id' in msg) || typeof msg.device_id !== 'number') return null;
  if (!('nonce' in msg) || typeof msg.nonce !== 'string') return null;
  if (!('signature' in msg) || typeof msg.signature !== 'string') return null;
  return { deviceId: msg.device_id, nonce: msg.nonce, signature: msg.signature };
}

/**
 * How long the server waits for `call:accept` (or `call:reject` /
 * `call:cancel`) on a `pending` call before declaring it unanswered and
 * collapsing the state to `closed`. Tuned for a worst-case Web Push
 * round-trip on a cold-launched PWA — ~1-3s push, ~8-15s human
 * reach-and-tap, ~2-4s app boot + WS reconnect.
 */
export const DEFAULT_UNANSWERED_MS = 25_000;

export interface FamilyPhoneWsHandlerOptions {
  /** Override the unanswered timeout. Tests pass a tiny value. */
  unansweredMs?: number;
  /**
   * Inject a router instance so the Twilio bridge and the WS handler
   * share one FSM. When omitted the handler builds its own — the path
   * tests take.
   */
  router?: CallRouter;
}

export function createFamilyPhoneWsHandler(
  ctx: WsAppContext,
  onlineDevices: Set<number>,
  broadcastTopic: string,
  options: FamilyPhoneWsHandlerOptions = {},
): WsMessageHandler {
  const unansweredMs = options.unansweredMs ?? DEFAULT_UNANSWERED_MS;
  const challenges = createFamilyPhoneChallengesRepo(ctx.db);
  const deviceKeys = createFamilyPhoneDeviceKeysRepo(ctx.db);
  const sessions = createFamilyPhoneDeviceSessionsRepo(ctx.db);
  const pushSubs: FamilyPhonePushSubscriptionsRepo = createFamilyPhonePushSubscriptionsRepo(ctx.db);
  const fireOfflineCallWake = createFireOfflineCallWake(ctx.db);
  const authDeps = {
    challenges,
    deviceKeys,
    sessions,
    now: () => new Date(),
    randomNonce: () => new Uint8Array(0), // unused on the auth path
    randomToken: defaultRandomToken,
  };

  const router =
    options.router ??
    createCallRouter({
      ws: ctx.ws,
      unansweredMs,
      onCallInviteOfflineTarget: (fromDeviceId, targetDeviceId) => {
        void fireOfflineCallWake(targetDeviceId, fromDeviceId);
      },
    });

  return {
    /**
     * Family-phone device auth handshake. The device sends a previously
     * obtained nonce, signed by the private half of its registered key.
     * The verification path mirrors the HTTP `/device/auth` endpoint; on
     * success the connection is bound to the device id for the lifetime
     * of the socket.
     */
    async authenticate(ws, msg): Promise<boolean> {
      const fields = readDeviceAuth(msg);
      if (!fields) return false;
      try {
        await authCore(authDeps, fields);
      } catch (err) {
        if (err instanceof AuthError) return false;
        throw err;
      }
      router.registerRealDevice(fields.deviceId, ws.id);
      onlineDevices.add(fields.deviceId);
      // Every authed device joins the broadcast topic so each one receives
      // presence and directory updates as they happen. The presence event
      // goes out *after* subscribe so the newly-online device sees itself
      // in the broadcast and other devices learn about it.
      ctx.ws.subscribe(ws, broadcastTopic);
      ctx.ws.broadcast(broadcastTopic, {
        type: 'presence:changed',
        device_id: fields.deviceId,
        online: true,
      });
      return true;
    },

    onMessage(ws: WsLike, msg: unknown, _principal): void {
      if (typeof msg !== 'object' || msg === null || !('type' in msg)) return;
      const type = msg.type;
      if (typeof type !== 'string') return;
      const deviceId = router.deviceIdFor(ws.id);
      if (deviceId === undefined) return;

      if (type.startsWith('call:')) {
        router.submitEvent(ws.id, msg);
        return;
      }

      switch (type) {
        case 'push:subscribe': {
          // The authed device registers (or refreshes) its Web Push
          // subscription. Upsert keyed by endpoint so a re-subscribe
          // with new keys (the vendor occasionally rotates them) lands
          // in place. The deviceId comes from the WS session, not the
          // payload, so a device can't register a subscription against
          // another device's id.
          const fields = readPushSubscribe(msg);
          if (!fields) {
            ws.send(JSON.stringify({ type: 'push:subscribe-failed', reason: 'bad-shape' }));
            return;
          }
          try {
            pushSubs.upsert({
              deviceId,
              endpoint: fields.endpoint,
              p256dh: fields.p256dh,
              auth: fields.auth,
            });
            ws.send(JSON.stringify({ type: 'push:subscribed' }));
          } catch (err) {
            console.error('[push] subscribe upsert failed:', err);
            ws.send(JSON.stringify({ type: 'push:subscribe-failed', reason: 'server-error' }));
          }
          return;
        }

        case 'push:unsubscribe': {
          // Drop the subscription row matching the supplied endpoint.
          // A device disabling notifications calls this so it stops
          // ringing; a device wiping its keys calls it on its way out.
          // No-op if the endpoint isn't registered.
          const fields = readPushUnsubscribe(msg);
          if (!fields) return;
          pushSubs.deleteByEndpoint(fields.endpoint);
          ws.send(JSON.stringify({ type: 'push:unsubscribed' }));
          return;
        }

        default:
          return;
      }
    },

    /**
     * Audio frames travel as binary with a 1-byte tag (0x10 = family-phone
     * audio) and a 16-byte call_id (UTF-8 of the call_id slice; encoded
     * here as a 16-byte ASCII prefix to keep wire-format simple). The
     * server looks up the call and forwards the entire frame to the peer.
     * Frames for non-active calls are dropped to enforce the safety
     * invariant: no audio after closed.
     */
    onBinary(ws: WsLike, frame: Uint8Array, _principal): void {
      router.submitBinary(ws.id, frame);
    },

    onClose(ws: WsLike): void {
      const deviceId = router.deviceIdFor(ws.id);
      router.unregisterDevice(ws.id);
      ctx.ws.unsubscribe(ws, broadcastTopic);
      if (deviceId !== undefined) {
        onlineDevices.delete(deviceId);
        ctx.ws.broadcast(broadcastTopic, {
          type: 'presence:changed',
          device_id: deviceId,
          online: false,
        });
      }
    },
  };
}
