import { describe, expect, test } from 'bun:test';
import { delay } from '@eal/shared';
import { createCallRouter, type VirtualDeviceSinks } from './family-phone-call-router.ts';
import type { WsLike, WsService } from '../apps/types.ts';

/**
 * Unit tests for the router's virtual surface — the part the Twilio bridge
 * (Phase 7B.4c) uses. The real-WS surface is covered by `family-phone.ws.test.ts`
 * end-to-end; here we exercise just the router with hand-rolled wsIds and
 * captured sink callbacks.
 */

interface Capture {
  send: Array<{ wsId: string; payload: Record<string, unknown> }>;
  binary: Array<{ wsId: string; frame: Uint8Array }>;
  service: WsService;
}

function toRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('captured payload is not an object');
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(payload)) {
    if (k in payload) out[k] = Reflect.get(payload, k);
  }
  return out;
}

function makeCapture(): Capture {
  const send: Capture['send'] = [];
  const binary: Capture['binary'] = [];
  const service: WsService = {
    sendTo(wsId, payload) {
      send.push({ wsId, payload: toRecord(payload) });
    },
    sendBinaryTo(wsId, frame) {
      binary.push({ wsId, frame });
    },
    subscribe(_ws: WsLike, _topic: string) {},
    unsubscribe(_ws: WsLike, _topic: string) {},
    broadcast() {},
    *connectedPrincipals() {},
  };
  return { send, binary, service };
}

function makeSinks(): {
  sinks: VirtualDeviceSinks;
  events: Array<Record<string, unknown>>;
  audio: Uint8Array[];
} {
  const events: Array<Record<string, unknown>> = [];
  const audio: Uint8Array[] = [];
  const sinks: VirtualDeviceSinks = {
    onEvent(payload) {
      events.push(payload);
    },
    onAudioFrame(frame) {
      audio.push(frame);
    },
  };
  return { sinks, events, audio };
}

function frameFor(callId: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer(1 + 16 + payload.length));
  out[0] = 0x10;
  const cid = new TextEncoder().encode(callId).slice(0, 16);
  out.set(cid, 1);
  out.set(payload, 17);
  return out;
}

describe('family-phone-call-router — virtual surface', () => {
  test('placeCallFromVirtual rings the registered handset via its real wsId', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    const { sinks } = makeSinks();

    router.registerRealDevice(42, 'handset-ws');
    router.registerVirtualDevice(-1, sinks);

    const res = router.placeCallFromVirtual(-1, 42);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const incoming = cap.send.find((c) => c.wsId === 'handset-ws');
    expect(incoming?.payload).toMatchObject({
      type: 'call:incoming',
      call_id: res.callId,
      from_device_id: -1,
    });
  });

  test('handset accept routes call:accepted to the virtual sink', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    const { sinks, events } = makeSinks();

    router.registerRealDevice(42, 'handset-ws');
    router.registerVirtualDevice(-1, sinks);
    const res = router.placeCallFromVirtual(-1, 42);
    if (!res.ok) throw new Error('no callId');

    router.submitEvent('handset-ws', { type: 'call:accept', call_id: res.callId });

    const accepted = events.find((e) => e['type'] === 'call:accepted');
    expect(accepted?.['call_id']).toBe(res.callId);
  });

  test('first-accept-wins: virtual side cancels its second pending invite', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    const { sinks } = makeSinks();

    router.registerRealDevice(42, 'handset-a');
    router.registerRealDevice(43, 'handset-b');
    router.registerVirtualDevice(-1, sinks);

    const a = router.placeCallFromVirtual(-1, 42);
    const b = router.placeCallFromVirtual(-1, 43);
    if (!a.ok || !b.ok) throw new Error('expected both invites to open');

    router.submitEvent('handset-a', { type: 'call:accept', call_id: a.callId });
    // The virtual side now cancels the loser.
    router.submitEvent('virtual:-1', { type: 'call:cancel', call_id: b.callId });

    const cancelled = cap.send.find(
      (c) => c.wsId === 'handset-b' && c.payload['type'] === 'call:cancelled',
    );
    expect(cancelled?.payload['call_id']).toBe(b.callId);
  });

  test('audio from real handset whose peer is virtual fires onAudioFrame', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    const { sinks, audio } = makeSinks();

    router.registerRealDevice(42, 'handset-ws');
    router.registerVirtualDevice(-1, sinks);
    const res = router.placeCallFromVirtual(-1, 42);
    if (!res.ok) throw new Error('no callId');
    router.submitEvent('handset-ws', { type: 'call:accept', call_id: res.callId });

    const f = frameFor(res.callId, new Uint8Array([1, 2, 3, 4]));
    router.submitBinary('handset-ws', f);

    expect(audio).toHaveLength(1);
    expect(audio[0]).toEqual(f);
    expect(cap.binary).toHaveLength(0); // no real-WS forward
  });

  test('audio from the virtual side reaches the real peer via WsService.sendBinaryTo', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    const { sinks } = makeSinks();

    router.registerRealDevice(42, 'handset-ws');
    router.registerVirtualDevice(-1, sinks);
    const res = router.placeCallFromVirtual(-1, 42);
    if (!res.ok) throw new Error('no callId');
    router.submitEvent('handset-ws', { type: 'call:accept', call_id: res.callId });

    const f = frameFor(res.callId, new Uint8Array([9, 9, 9]));
    router.submitBinary('virtual:-1', f);

    expect(cap.binary).toHaveLength(1);
    expect(cap.binary[0]?.wsId).toBe('handset-ws');
    expect(cap.binary[0]?.frame).toEqual(f);
  });

  test('unregisterDevice on the virtual side hangs up the connected handset', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    const { sinks } = makeSinks();

    router.registerRealDevice(42, 'handset-ws');
    router.registerVirtualDevice(-1, sinks);
    const res = router.placeCallFromVirtual(-1, 42);
    if (!res.ok) throw new Error('no callId');
    router.submitEvent('handset-ws', { type: 'call:accept', call_id: res.callId });

    router.unregisterDevice('virtual:-1');

    const hungUp = cap.send.find(
      (c) => c.wsId === 'handset-ws' && c.payload['type'] === 'call:hung-up',
    );
    expect(hungUp?.payload['reason']).toBe('peer-disconnect');
    expect(hungUp?.payload['call_id']).toBe(res.callId);
  });

  test('placeCallFromVirtual rejects when target device is not registered', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    const { sinks } = makeSinks();
    router.registerVirtualDevice(-1, sinks);

    const res = router.placeCallFromVirtual(-1, 9999);
    expect(res).toEqual({ ok: false, reason: 'target-offline' });
  });

  test('placeCallFromVirtual rejects when the caller is not a registered virtual device', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(42, 'handset-ws');

    // 42 is real, not virtual; the bridge entry point refuses to mint a
    // call on its behalf. This guards against the bridge ever calling
    // placeCallFromVirtual with a real device id by mistake.
    const res = router.placeCallFromVirtual(42, 99);
    expect(res.ok).toBe(false);
  });

  test('virtual offline-target invite skips the onCallInviteOfflineTarget callback', () => {
    const cap = makeCapture();
    const fired: Array<{ from: number; to: number }> = [];
    const router = createCallRouter({
      ws: cap.service,
      unansweredMs: 60_000,
      onCallInviteOfflineTarget: (from, to) => fired.push({ from, to }),
    });
    const { sinks } = makeSinks();
    router.registerVirtualDevice(-1, sinks);

    // Bridge submits invite via submitEvent (the placeCallFromVirtual
    // alias path also exists, but the bridge uses both — this guards
    // the submitEvent path against accidentally firing push for a
    // virtual caller).
    router.submitEvent('virtual:-1', { type: 'call:invite', target_device_id: 9999 });
    expect(fired).toHaveLength(0);
  });

  test('the unanswered timer collapses a virtual-side call and notifies both sinks', async () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 5 });
    const { sinks, events } = makeSinks();

    router.registerRealDevice(42, 'handset-ws');
    router.registerVirtualDevice(-1, sinks);
    router.placeCallFromVirtual(-1, 42);

    await delay(40);

    expect(events.find((e) => e['type'] === 'call:unanswered')).toBeDefined();
    const cancelled = cap.send.find(
      (c) => c.wsId === 'handset-ws' && c.payload['type'] === 'call:cancelled',
    );
    expect(cancelled).toBeDefined();
  });
});
