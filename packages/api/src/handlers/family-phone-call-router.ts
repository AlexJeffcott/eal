import { randomBytes } from 'node:crypto';
import type { WsService } from '../apps/types.ts';

/**
 * The call FSM, lifted out of `family-phone.ws.ts` so the Twilio bridge
 * (Phase 7B.4c) can participate as a virtual device without going through a
 * loopback WebSocket. Real-WS behaviour is unchanged — the WS handler is now
 * a thin shim that delegates every `call:*` event and every binary frame to
 * the router. The router additionally exposes a virtual surface that the
 * bridge wires its `send`/`onAudioFrame` callbacks into.
 *
 * A virtual device's `wsId` is `"virtual:<deviceId>"`. The router's internal
 * `sendTo`/`sendBinaryTo` check that prefix and dispatch to the registered
 * sinks instead of the underlying `WsService`. Everything else — `calls`,
 * `unansweredTimers`, the per-event switch — is verbatim from the previous
 * handler so the existing `family-phone.ws.test.ts` keeps passing.
 */

interface CallState {
  callId: string;
  caller: { wsId: string; deviceId: number };
  callee: { wsId: string; deviceId: number };
  state: 'pending' | 'connected' | 'closed';
}

export interface VirtualDeviceSinks {
  onEvent(payload: Record<string, unknown>): void;
  onAudioFrame(frame: Uint8Array): void;
}

export interface PlaceCallResult {
  ok: true;
  callId: string;
}

export interface PlaceCallFailure {
  ok: false;
  reason: 'missing-target' | 'target-offline';
}

export interface CallRouter {
  /** Bind a real WS connection to its authenticated device id. */
  registerRealDevice(deviceId: number, wsId: string): void;
  /**
   * Tear down everything the router knows about this wsId — clear the
   * device maps, fire `call:hung-up` (reason `peer-disconnect`) to any
   * live peer. Works for both real and virtual wsIds.
   */
  unregisterDevice(wsId: string): void;
  /**
   * Register a server-internal participant. Returns the synthesised wsId
   * (`"virtual:<deviceId>"`) the bridge uses with `submitEvent` /
   * `submitBinary`. The sinks receive events the router would otherwise
   * send over a real WS.
   */
  registerVirtualDevice(deviceId: number, sinks: VirtualDeviceSinks): string;
  /** Read the device id bound to a wsId (real or virtual). */
  deviceIdFor(wsId: string): number | undefined;
  /** Handle a `call:*` envelope from a connection. */
  submitEvent(wsId: string, msg: unknown): void;
  /** Handle a binary audio frame from a connection. */
  submitBinary(wsId: string, frame: Uint8Array): void;
  /**
   * Place a call from a virtual device. The virtual side must already be
   * registered via `registerVirtualDevice`. The target may be real or
   * virtual; the FSM does not care.
   */
  placeCallFromVirtual(
    fromDeviceId: number,
    toDeviceId: number,
  ): PlaceCallResult | PlaceCallFailure;
}

export interface CallRouterDeps {
  ws: WsService;
  unansweredMs: number;
  /**
   * Fired when a real-WS `call:invite` targets a device that isn't
   * currently registered. The WS handler uses this to schedule a Web Push
   * wake — that policy stays out of the router so the bridge doesn't
   * inherit it.
   */
  onCallInviteOfflineTarget?: (fromDeviceId: number, targetDeviceId: number) => void;
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

function isVirtual(wsId: string): boolean {
  return wsId.startsWith('virtual:');
}

export function createCallRouter(deps: CallRouterDeps): CallRouter {
  const { ws, unansweredMs } = deps;

  const wsDevices = new Map<string, number>();
  const deviceToWs = new Map<number, string>();
  const calls = new Map<string, CallState>();
  const unansweredTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const virtualSinks = new Map<string, VirtualDeviceSinks>();

  function sendTo(wsId: string, payload: Record<string, unknown>): void {
    const sinks = virtualSinks.get(wsId);
    if (sinks !== undefined) {
      sinks.onEvent(payload);
      return;
    }
    ws.sendTo(wsId, payload);
  }

  function sendBinaryTo(wsId: string, frame: Uint8Array): void {
    const sinks = virtualSinks.get(wsId);
    if (sinks !== undefined) {
      sinks.onAudioFrame(frame);
      return;
    }
    ws.sendBinaryTo(wsId, frame);
  }

  function cancelUnansweredTimer(callId: string): void {
    const handle = unansweredTimers.get(callId);
    if (handle === undefined) return;
    clearTimeout(handle);
    unansweredTimers.delete(callId);
  }

  function scheduleUnansweredTimer(callId: string): void {
    const handle = setTimeout(() => {
      unansweredTimers.delete(callId);
      const call = calls.get(callId);
      if (!call || call.state !== 'pending') return;
      call.state = 'closed';
      sendTo(call.caller.wsId, { type: 'call:unanswered', call_id: callId });
      sendTo(call.callee.wsId, { type: 'call:cancelled', call_id: callId });
    }, unansweredMs);
    unansweredTimers.set(callId, handle);
  }

  function peerOf(call: CallState, wsId: string): { wsId: string; deviceId: number } | null {
    if (call.caller.wsId === wsId) return call.callee;
    if (call.callee.wsId === wsId) return call.caller;
    return null;
  }

  function openCall(
    caller: { wsId: string; deviceId: number },
    callee: { wsId: string; deviceId: number },
  ): string {
    const callId = randomBytes(8).toString('hex');
    calls.set(callId, { callId, caller, callee, state: 'pending' });
    sendTo(callee.wsId, {
      type: 'call:incoming',
      call_id: callId,
      from_device_id: caller.deviceId,
    });
    scheduleUnansweredTimer(callId);
    return callId;
  }

  function handleInvite(wsId: string, deviceId: number, msg: unknown): void {
    const targetDeviceId = readTargetDeviceId(msg);
    if (targetDeviceId === null) {
      sendTo(wsId, { type: 'call:invite-failed', reason: 'missing-target' });
      return;
    }
    const targetWsId = deviceToWs.get(targetDeviceId);
    if (!targetWsId) {
      if (!isVirtual(wsId)) {
        deps.onCallInviteOfflineTarget?.(deviceId, targetDeviceId);
      }
      sendTo(wsId, { type: 'call:invite-failed', reason: 'target-offline' });
      return;
    }
    const callId = openCall(
      { wsId, deviceId },
      { wsId: targetWsId, deviceId: targetDeviceId },
    );
    sendTo(wsId, { type: 'call:invite-ack', call_id: callId });
  }

  return {
    registerRealDevice(deviceId, wsId) {
      wsDevices.set(wsId, deviceId);
      deviceToWs.set(deviceId, wsId);
    },

    registerVirtualDevice(deviceId, sinks) {
      const wsId = `virtual:${deviceId}`;
      virtualSinks.set(wsId, sinks);
      wsDevices.set(wsId, deviceId);
      deviceToWs.set(deviceId, wsId);
      return wsId;
    },

    unregisterDevice(wsId) {
      const deviceId = wsDevices.get(wsId);
      wsDevices.delete(wsId);
      virtualSinks.delete(wsId);
      if (deviceId !== undefined) deviceToWs.delete(deviceId);
      for (const call of calls.values()) {
        if (call.state === 'closed') continue;
        const peer = peerOf(call, wsId);
        if (!peer) continue;
        cancelUnansweredTimer(call.callId);
        call.state = 'closed';
        sendTo(peer.wsId, {
          type: 'call:hung-up',
          call_id: call.callId,
          reason: 'peer-disconnect',
        });
      }
    },

    deviceIdFor(wsId) {
      return wsDevices.get(wsId);
    },

    placeCallFromVirtual(fromDeviceId, toDeviceId) {
      const fromWsId = deviceToWs.get(fromDeviceId);
      if (!fromWsId || !isVirtual(fromWsId)) {
        return { ok: false, reason: 'missing-target' };
      }
      const targetWsId = deviceToWs.get(toDeviceId);
      if (!targetWsId) return { ok: false, reason: 'target-offline' };
      const callId = openCall(
        { wsId: fromWsId, deviceId: fromDeviceId },
        { wsId: targetWsId, deviceId: toDeviceId },
      );
      return { ok: true, callId };
    },

    submitEvent(wsId, msg) {
      if (typeof msg !== 'object' || msg === null || !('type' in msg)) return;
      const type = msg.type;
      if (typeof type !== 'string') return;
      const deviceId = wsDevices.get(wsId);
      if (deviceId === undefined) return;

      switch (type) {
        case 'call:invite': {
          handleInvite(wsId, deviceId, msg);
          return;
        }

        case 'call:accept': {
          const callId = readCallId(msg);
          if (!callId) return;
          const call = calls.get(callId);
          if (!call || call.state !== 'pending') return;
          if (call.callee.wsId !== wsId) return;
          cancelUnansweredTimer(callId);
          call.state = 'connected';
          sendTo(call.caller.wsId, { type: 'call:accepted', call_id: callId });
          sendTo(wsId, { type: 'call:accept-ack', call_id: callId });
          return;
        }

        case 'call:reject': {
          const callId = readCallId(msg);
          if (!callId) return;
          const call = calls.get(callId);
          if (!call || call.state !== 'pending') return;
          if (call.callee.wsId !== wsId) return;
          cancelUnansweredTimer(callId);
          call.state = 'closed';
          sendTo(call.caller.wsId, { type: 'call:rejected', call_id: callId });
          return;
        }

        case 'call:cancel': {
          const callId = readCallId(msg);
          if (!callId) return;
          const call = calls.get(callId);
          if (!call || call.state !== 'pending') return;
          if (call.caller.wsId !== wsId) return;
          cancelUnansweredTimer(callId);
          call.state = 'closed';
          sendTo(call.callee.wsId, { type: 'call:cancelled', call_id: callId });
          return;
        }

        case 'call:text': {
          const callId = readCallId(msg);
          if (!callId) return;
          if (!('text' in msg) || typeof msg.text !== 'string') return;
          const text = msg.text;
          const call = calls.get(callId);
          if (!call || call.state !== 'connected') return;
          const peer = peerOf(call, wsId);
          if (!peer) return;
          sendTo(peer.wsId, { type: 'call:text', call_id: callId, text });
          return;
        }

        case 'call:hangup': {
          const callId = readCallId(msg);
          if (!callId) return;
          const call = calls.get(callId);
          if (!call) return;
          if (call.state !== 'connected') return;
          const peer = peerOf(call, wsId);
          if (!peer) return;
          cancelUnansweredTimer(callId);
          call.state = 'closed';
          sendTo(peer.wsId, { type: 'call:hung-up', call_id: callId });
          return;
        }

        default:
          return;
      }
    },

    submitBinary(wsId, frame) {
      if (frame.length < 1 + 16) return;
      const callIdBytes = frame.slice(1, 17);
      const callId = new TextDecoder().decode(callIdBytes).replace(/\0+$/, '');
      const call = calls.get(callId);
      if (!call || call.state !== 'connected') return;
      const peer = peerOf(call, wsId);
      if (!peer) return;
      sendBinaryTo(peer.wsId, frame);
    },
  };
}
