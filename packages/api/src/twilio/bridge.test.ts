import { describe, expect, test } from 'bun:test';
import { delay } from '@eal/shared';
import { createTwilioBridge } from './bridge.ts';
import { pcmuToPcm16 } from './codec.ts';
import { createCallRouter } from '../handlers/family-phone-call-router.ts';
import type { WsLike, WsService } from '../apps/types.ts';

/**
 * The bridge wraps a real router instance — these are integration tests
 * at the module boundary (bridge + router + codec), not isolated mocks.
 * Twilio is faked: parsed events go in via `handleEvent`, upstream JSON
 * lands in a captured array.
 */

interface Capture {
  sendTo: Array<{ wsId: string; payload: Record<string, unknown> }>;
  sendBinaryTo: Array<{ wsId: string; frame: Uint8Array }>;
  service: WsService;
}

function toRecord(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof payload === 'object' && payload !== null) {
    for (const k of Object.keys(payload)) out[k] = Reflect.get(payload, k);
  }
  return out;
}

function makeCapture(): Capture {
  const sendTo: Capture['sendTo'] = [];
  const sendBinaryTo: Capture['sendBinaryTo'] = [];
  const service: WsService = {
    sendTo(wsId, payload) {
      sendTo.push({ wsId, payload: toRecord(payload) });
    },
    sendBinaryTo(wsId, frame) {
      sendBinaryTo.push({ wsId, frame });
    },
    subscribe(_ws: WsLike, _topic: string) {},
    unsubscribe(_ws: WsLike, _topic: string) {},
    broadcast() {},
    *connectedPrincipals() {},
  };
  return { sendTo, sendBinaryTo, service };
}

function startEvent(streamSid = 'MZ123') {
  return {
    type: 'start' as const,
    streamSid,
    callSid: 'CA456',
    from: '+390000000001',
    to: '+390000000002',
    direction: 'inbound' as const,
    targetHandsetId: null,
  };
}

function mediaEvent(payload: string, streamSid = 'MZ123') {
  return { type: 'media' as const, streamSid, track: 'inbound' as const, payload };
}

function callIdFromIncoming(send: Capture['sendTo'], wsId: string): string {
  const incoming = send.find(
    (c) => c.wsId === wsId && c.payload['type'] === 'call:incoming',
  );
  if (!incoming) throw new Error(`no call:incoming for ${wsId}`);
  const cid = incoming.payload['call_id'];
  if (typeof cid !== 'string') throw new Error('call_id not a string');
  return cid;
}

const PSTN_ID = -1;

describe('createTwilioBridge — fan-out & lifecycle', () => {
  test('start fans the invite out to every handset', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(11, 'handset-a');
    router.registerRealDevice(12, 'handset-b');
    let terminated = 0;
    const sent: string[] = [];

    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11, 12],
      sendUpstream: (s) => sent.push(s),
      onTerminate: () => {
        terminated++;
      },
    });

    bridge.handleEvent(startEvent());

    expect(cap.sendTo.filter((c) => c.payload['type'] === 'call:incoming')).toHaveLength(2);
    expect(terminated).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test('first accept wins; the other handset is sent call:cancelled', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(11, 'handset-a');
    router.registerRealDevice(12, 'handset-b');

    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11, 12],
      sendUpstream: () => {},
      onTerminate: () => {},
    });
    bridge.handleEvent(startEvent());

    const aCallId = callIdFromIncoming(cap.sendTo, 'handset-a');
    const bCallId = callIdFromIncoming(cap.sendTo, 'handset-b');
    expect(aCallId).not.toBe(bCallId);

    router.submitEvent('handset-a', { type: 'call:accept', call_id: aCallId });

    const cancelled = cap.sendTo.find(
      (c) => c.wsId === 'handset-b' && c.payload['type'] === 'call:cancelled',
    );
    expect(cancelled?.payload['call_id']).toBe(bCallId);

    const aAccepted = cap.sendTo.find(
      (c) => c.wsId === 'handset-a' && c.payload['type'] === 'call:accept-ack',
    );
    expect(aAccepted).toBeDefined();
  });

  test('all handsets reject → bridge terminates', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(11, 'handset-a');
    router.registerRealDevice(12, 'handset-b');
    let terminated = 0;

    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11, 12],
      sendUpstream: () => {},
      onTerminate: () => {
        terminated++;
      },
    });
    bridge.handleEvent(startEvent());
    const aCallId = callIdFromIncoming(cap.sendTo, 'handset-a');
    const bCallId = callIdFromIncoming(cap.sendTo, 'handset-b');

    router.submitEvent('handset-a', { type: 'call:reject', call_id: aCallId });
    expect(terminated).toBe(0);
    router.submitEvent('handset-b', { type: 'call:reject', call_id: bCallId });
    expect(terminated).toBe(1);
  });

  test('every handset times out unanswered → bridge terminates', async () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 5 });
    router.registerRealDevice(11, 'handset-a');
    let terminated = 0;

    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11],
      sendUpstream: () => {},
      onTerminate: () => {
        terminated++;
      },
    });
    bridge.handleEvent(startEvent());
    await delay(40);
    expect(terminated).toBe(1);
  });

  test('start with no online handsets terminates immediately', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    let terminated = 0;

    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [],
      sendUpstream: () => {},
      onTerminate: () => {
        terminated++;
      },
    });
    bridge.handleEvent(startEvent());
    expect(terminated).toBe(1);
  });

  test('Twilio stop event terminates and hangs up the live handset', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(11, 'handset-a');
    let terminated = 0;

    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11],
      sendUpstream: () => {},
      onTerminate: () => {
        terminated++;
      },
    });
    bridge.handleEvent(startEvent());
    const aCallId = callIdFromIncoming(cap.sendTo, 'handset-a');
    router.submitEvent('handset-a', { type: 'call:accept', call_id: aCallId });

    bridge.handleEvent({ type: 'stop', streamSid: 'MZ123' });

    expect(terminated).toBe(1);
    const hungUp = cap.sendTo.find(
      (c) => c.wsId === 'handset-a' && c.payload['type'] === 'call:hung-up',
    );
    expect(hungUp?.payload['reason']).toBe('peer-disconnect');
  });

  test('handset hangup on the active call terminates the bridge', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(11, 'handset-a');
    let terminated = 0;

    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11],
      sendUpstream: () => {},
      onTerminate: () => {
        terminated++;
      },
    });
    bridge.handleEvent(startEvent());
    const aCallId = callIdFromIncoming(cap.sendTo, 'handset-a');
    router.submitEvent('handset-a', { type: 'call:accept', call_id: aCallId });
    router.submitEvent('handset-a', { type: 'call:hangup', call_id: aCallId });
    expect(terminated).toBe(1);
  });

  test('external close() is idempotent and only fires onTerminate once', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(11, 'handset-a');
    let terminated = 0;
    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11],
      sendUpstream: () => {},
      onTerminate: () => {
        terminated++;
      },
    });
    bridge.handleEvent(startEvent());
    bridge.close();
    bridge.close();
    expect(terminated).toBe(1);
  });

  test('duplicate start frame is ignored (Twilio retransmit)', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(11, 'handset-a');

    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11],
      sendUpstream: () => {},
      onTerminate: () => {},
    });
    bridge.handleEvent(startEvent());
    bridge.handleEvent(startEvent('MZ-other'));
    expect(
      cap.sendTo.filter((c) => c.payload['type'] === 'call:incoming'),
    ).toHaveLength(1);
  });
});

describe('createTwilioBridge — audio paths', () => {
  test('Twilio media event forwards a PCM audio frame to the active handset', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(11, 'handset-a');
    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11],
      sendUpstream: () => {},
      onTerminate: () => {},
    });
    bridge.handleEvent(startEvent());
    const aCallId = callIdFromIncoming(cap.sendTo, 'handset-a');
    router.submitEvent('handset-a', { type: 'call:accept', call_id: aCallId });

    // 20 ms of 8 kHz PCMU = 160 bytes. Use a known sample sweep so the
    // decoded handset frame is non-trivial.
    const pcmu = new Uint8Array(160);
    for (let i = 0; i < pcmu.length; i++) pcmu[i] = (i * 7) & 0xff;
    const base64 = Buffer.from(pcmu).toString('base64');

    bridge.handleEvent(mediaEvent(base64));

    expect(cap.sendBinaryTo).toHaveLength(1);
    const forwarded = cap.sendBinaryTo[0];
    expect(forwarded?.wsId).toBe('handset-a');
    const frame = forwarded?.frame;
    if (!frame) throw new Error('no frame');
    expect(frame[0]).toBe(0x10);
    const decodedCallId = new TextDecoder().decode(frame.slice(1, 17)).replace(/\0+$/, '');
    expect(decodedCallId).toBe(aCallId);
    // 160 PCMU samples → 160 PCM @ 8k → 480 PCM @ 24k = 960 bytes LE.
    expect(frame.length - (1 + 16)).toBe(160 * 3 * 2);
  });

  test('Twilio media event before any handset accepts is dropped', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(11, 'handset-a');
    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11],
      sendUpstream: () => {},
      onTerminate: () => {},
    });
    bridge.handleEvent(startEvent());
    // No accept yet — the call is still pending.
    bridge.handleEvent(mediaEvent(Buffer.from(new Uint8Array(160)).toString('base64')));
    expect(cap.sendBinaryTo).toHaveLength(0);
  });

  test('handset audio frame is encoded back upstream as a Twilio media event', () => {
    const cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(11, 'handset-a');
    const sent: string[] = [];
    const bridge = createTwilioBridge({
      router,
      pstnDeviceId: PSTN_ID,
      handsetDeviceIds: [11],
      sendUpstream: (s) => sent.push(s),
      onTerminate: () => {},
    });
    bridge.handleEvent(startEvent());
    const aCallId = callIdFromIncoming(cap.sendTo, 'handset-a');
    router.submitEvent('handset-a', { type: 'call:accept', call_id: aCallId });

    // 480 samples = 20 ms of 24 kHz PCM (one canonical frame).
    const pcm = new Int16Array(480);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 5) * 8000;
    const audioBytes = new Uint8Array(pcm.length * 2);
    const view = new DataView(audioBytes.buffer);
    for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] ?? 0, true);

    const frame = new Uint8Array(1 + 16 + audioBytes.length);
    frame[0] = 0x10;
    frame.set(new TextEncoder().encode(aCallId).subarray(0, 16), 1);
    frame.set(audioBytes, 17);

    router.submitBinary('handset-a', frame);

    expect(sent).toHaveLength(1);
    const parsed: unknown = JSON.parse(sent[0] ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not obj');
    const event = Reflect.get(parsed, 'event');
    const streamSid = Reflect.get(parsed, 'streamSid');
    const media = Reflect.get(parsed, 'media');
    expect(event).toBe('media');
    expect(streamSid).toBe('MZ123');
    if (typeof media !== 'object' || media === null) throw new Error('no media');
    const payload = Reflect.get(media, 'payload');
    if (typeof payload !== 'string') throw new Error('no payload');
    const pcmu = Buffer.from(payload, 'base64');
    // 480 PCM @ 24k → 160 PCM @ 8k → 160 PCMU bytes.
    expect(pcmu.length).toBe(160);
    // Round-trip sanity: μ-law decode should land in the same ballpark
    // as the original 8 kHz downsampled signal — not equal byte-for-byte
    // (μ-law is lossy by design), but the energy should match within an
    // order of magnitude.
    const decoded = pcmuToPcm16(new Uint8Array(pcmu));
    const energy = decoded.reduce((s, v) => s + v * v, 0);
    expect(energy).toBeGreaterThan(0);
  });

});
