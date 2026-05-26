import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { createFamilyPhoneChallengesRepo } from '../db/repos/family-phone-challenges.ts';
import { createFamilyPhoneDeviceKeysRepo } from '../db/repos/family-phone-device-keys.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import {
  createFamilyPhonePushSubscriptionsRepo,
  type FamilyPhonePushSubscriptionsRepo,
} from '../db/repos/family-phone-push-subscriptions.ts';
import { createFamilyPhoneDeviceSessionsRepo } from '../db/repos/family-phone-device-sessions.ts';
import { authCore, defaultRandomToken } from './family-phone-device-auth.shared.ts';
import { AuthError } from './auth.shared.ts';
import { loadPushVapidConfig } from './push.http.ts';
import type { WsAppContext, WsLike, WsMessageHandler } from '../apps/types.ts';

/**
 * In-process call state. Closes when the call enters `closed` — we never
 * resurrect a call_id, so once it's closed it sits as a tombstone until
 * the next eviction (a periodic sweep is future work; at family scale the
 * map stays tiny).
 */
interface CallState {
  callId: string;
  caller: { wsId: string; deviceId: number };
  callee: { wsId: string; deviceId: number };
  state: 'pending' | 'connected' | 'closed';
}

function readCallId(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg === null) return null;
  if (!('call_id' in msg) || typeof msg.call_id !== 'string') return null;
  return msg.call_id;
}

function readTargetDeviceId(msg: unknown): number | null {
  if (typeof msg !== 'object' || msg === null) return null;
  if (!('target_device_id' in msg) || typeof msg.target_device_id !== 'number') return null;
  return msg.target_device_id;
}

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

export function createFamilyPhoneWsHandler(
  ctx: WsAppContext,
  onlineDevices: Set<number>,
  broadcastTopic: string,
): WsMessageHandler {
  const challenges = createFamilyPhoneChallengesRepo(ctx.db);
  const deviceKeys = createFamilyPhoneDeviceKeysRepo(ctx.db);
  const sessions = createFamilyPhoneDeviceSessionsRepo(ctx.db);
  const pushSubs: FamilyPhonePushSubscriptionsRepo = createFamilyPhonePushSubscriptionsRepo(ctx.db);
  const devicesRepo = createFamilyPhoneDevicesRepo(ctx.db);
  // VAPID config is read once when the handler boots. Calling
  // sendNotification when this is null is wasted work — the
  // module-global webpush.setVapidDetails was skipped at boot, so
  // every call would throw. Guard the offline-wake branch on it.
  const vapid = loadPushVapidConfig();
  const authDeps = {
    challenges,
    deviceKeys,
    sessions,
    now: () => new Date(),
    randomNonce: () => new Uint8Array(0), // unused on the auth path
    randomToken: defaultRandomToken,
  };

  /** ws.id → deviceId. Set by `authenticate`, cleared by `onClose`. */
  const wsDevices = new Map<string, number>();
  /** deviceId → ws.id. Maintained alongside wsDevices for O(1) target lookup. */
  const deviceToWs = new Map<number, string>();
  /** Active and recently-closed calls, keyed by server-minted call_id. */
  const calls = new Map<string, CallState>();

  function peerOf(call: CallState, wsId: string): { wsId: string; deviceId: number } | null {
    if (call.caller.wsId === wsId) return call.callee;
    if (call.callee.wsId === wsId) return call.caller;
    return null;
  }

  /**
   * Fire a Web Push notification at every push subscription registered
   * for `targetDeviceId`. Called when a call:invite finds the target
   * offline — the call itself still fails (the caller's UI shows
   * target-offline), but the recipient's phone buzzes so they can
   * open the app and call back.
   *
   * Best-effort: VAPID misconfiguration, network failures, and vendor
   * errors all short-circuit silently. A vendor 404/410 deletes the
   * stale subscription row so future invites skip it.
   */
  async function fireOfflineCallWake(
    targetDeviceId: number,
    callerDeviceId: number,
  ): Promise<void> {
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
  }

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
      wsDevices.set(ws.id, fields.deviceId);
      deviceToWs.set(fields.deviceId, ws.id);
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
      const deviceId = wsDevices.get(ws.id);
      if (deviceId === undefined) return;

      switch (type) {
        case 'call:invite': {
          const targetDeviceId = readTargetDeviceId(msg);
          if (targetDeviceId === null) {
            ws.send(JSON.stringify({ type: 'call:invite-failed', reason: 'missing-target' }));
            return;
          }
          const targetWsId = deviceToWs.get(targetDeviceId);
          if (!targetWsId) {
            // Target isn't on the WS — the call itself can't go through
            // (no media path), but if the target has a registered push
            // subscription we ring its phone so the human can open the
            // app and call back. The notification fires async; the
            // caller's UI sees `call:invite-failed` immediately, same as
            // before, so existing behaviour is preserved.
            void fireOfflineCallWake(targetDeviceId, deviceId);
            ws.send(JSON.stringify({ type: 'call:invite-failed', reason: 'target-offline' }));
            return;
          }
          // 16 ASCII characters of hex so the call_id fits exactly into the
          // 16-byte field of the binary audio frame header.
          const callId = randomBytes(8).toString('hex');
          calls.set(callId, {
            callId,
            caller: { wsId: ws.id, deviceId },
            callee: { wsId: targetWsId, deviceId: targetDeviceId },
            state: 'pending',
          });
          ws.send(JSON.stringify({ type: 'call:invite-ack', call_id: callId }));
          ctx.ws.sendTo(targetWsId, {
            type: 'call:incoming',
            call_id: callId,
            from_device_id: deviceId,
          });
          return;
        }

        case 'call:accept': {
          const callId = readCallId(msg);
          if (!callId) return;
          const call = calls.get(callId);
          if (!call || call.state !== 'pending') return;
          if (call.callee.wsId !== ws.id) return; // only the callee may accept
          call.state = 'connected';
          ctx.ws.sendTo(call.caller.wsId, { type: 'call:accepted', call_id: callId });
          ws.send(JSON.stringify({ type: 'call:accept-ack', call_id: callId }));
          return;
        }

        case 'call:reject': {
          const callId = readCallId(msg);
          if (!callId) return;
          const call = calls.get(callId);
          if (!call || call.state !== 'pending') return;
          if (call.callee.wsId !== ws.id) return; // only the callee may reject
          call.state = 'closed';
          ctx.ws.sendTo(call.caller.wsId, { type: 'call:rejected', call_id: callId });
          return;
        }

        case 'call:cancel': {
          const callId = readCallId(msg);
          if (!callId) return;
          const call = calls.get(callId);
          if (!call || call.state !== 'pending') return;
          if (call.caller.wsId !== ws.id) return; // only the caller may cancel
          call.state = 'closed';
          ctx.ws.sendTo(call.callee.wsId, { type: 'call:cancelled', call_id: callId });
          return;
        }

        case 'call:hangup': {
          const callId = readCallId(msg);
          if (!callId) return;
          const call = calls.get(callId);
          if (!call) return;
          // Hangup is the only way out of `connected`. Both peers may send
          // it; the second one finds the call already `closed` and is a
          // no-op (single-shot collapse).
          if (call.state !== 'connected') return;
          const peer = peerOf(call, ws.id);
          if (!peer) return;
          call.state = 'closed';
          ctx.ws.sendTo(peer.wsId, { type: 'call:hung-up', call_id: callId });
          return;
        }

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
      if (frame.length < 1 + 16) return;
      const callIdBytes = frame.slice(1, 17);
      const callId = new TextDecoder().decode(callIdBytes).replace(/\0+$/, '');
      const call = calls.get(callId);
      if (!call || call.state !== 'connected') return;
      const peer = peerOf(call, ws.id);
      if (!peer) return;
      ctx.ws.sendBinaryTo(peer.wsId, frame);
    },

    onClose(ws: WsLike): void {
      const deviceId = wsDevices.get(ws.id);
      wsDevices.delete(ws.id);
      ctx.ws.unsubscribe(ws, broadcastTopic);
      if (deviceId !== undefined) {
        deviceToWs.delete(deviceId);
        onlineDevices.delete(deviceId);
        ctx.ws.broadcast(broadcastTopic, {
          type: 'presence:changed',
          device_id: deviceId,
          online: false,
        });
      }
      // Tear down any call this connection was party to. The peer learns
      // via call:hung-up with reason 'peer-disconnect' so the UI can
      // distinguish a clean hangup from a crash.
      for (const call of calls.values()) {
        if (call.state === 'closed') continue;
        const peer = peerOf(call, ws.id);
        if (!peer) continue;
        call.state = 'closed';
        ctx.ws.sendTo(peer.wsId, {
          type: 'call:hung-up',
          call_id: call.callId,
          reason: 'peer-disconnect',
        });
      }
    },
  };
}
