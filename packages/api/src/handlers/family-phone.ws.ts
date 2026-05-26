import { randomBytes } from 'node:crypto';
import { createFamilyPhoneChallengesRepo } from '../db/repos/family-phone-challenges.ts';
import { createFamilyPhoneDeviceKeysRepo } from '../db/repos/family-phone-device-keys.ts';
import { createFamilyPhoneDeviceSessionsRepo } from '../db/repos/family-phone-device-sessions.ts';
import { authCore, defaultRandomToken } from './family-phone-device-auth.shared.ts';
import { AuthError } from './auth.shared.ts';
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
