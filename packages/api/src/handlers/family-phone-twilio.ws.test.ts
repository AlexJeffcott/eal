import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createCallRouter } from './family-phone-call-router.ts';
import {
  createFamilyPhoneDevicesRepo,
  type FamilyPhoneDevicesRepo,
} from '../db/repos/family-phone-devices.ts';
import {
  createTwilioMediaSession,
  type TwilioMediaSession,
  type TwilioMediaWs,
} from './family-phone-twilio.ws.session.ts';
import type { WsLike, WsService } from '../apps/types.ts';

/**
 * Tests cover the Elysia-shim layer: the per-connection bridge slot,
 * lazy construction on `start`, dispatch to the bridge on subsequent
 * frames, and the close-cleanup. Bridge internals are covered by
 * `twilio/bridge.test.ts`; here we only assert the integration seam.
 */

function makeWs(id: string): {
  ws: TwilioMediaWs;
  sent: string[];
  closed: () => boolean;
} {
  const sent: string[] = [];
  let closed = false;
  return {
    ws: {
      id,
      send(payload) {
        sent.push(payload);
      },
      close() {
        closed = true;
      },
    },
    sent,
    closed: () => closed,
  };
}

interface Capture {
  sendTo: Array<{ wsId: string; payload: Record<string, unknown> }>;
  sendBinaryTo: Array<{ wsId: string; frame: Uint8Array }>;
  service: WsService;
}

function makeCapture(): Capture {
  const sendTo: Capture['sendTo'] = [];
  const sendBinaryTo: Capture['sendBinaryTo'] = [];
  const service: WsService = {
    sendTo(wsId, payload) {
      const obj: Record<string, unknown> = {};
      if (typeof payload === 'object' && payload !== null) {
        for (const k of Object.keys(payload)) obj[k] = Reflect.get(payload, k);
      }
      sendTo.push({ wsId, payload: obj });
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

function startFrame(from: string, callSid = 'CA1', streamSid = 'MZ1', to = '+441234567890'): string {
  return JSON.stringify({
    event: 'start',
    start: {
      streamSid,
      callSid,
      customParameters: { from, to },
    },
  });
}

describe('createTwilioMediaSession', () => {
  let db: DatabaseClient;
  let devices: FamilyPhoneDevicesRepo;
  let cap: Capture;
  let session: TwilioMediaSession;
  let onlineDevices: Set<number>;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    db.prepare("INSERT INTO users (display_name) VALUES ('alex')").run();
    devices = createFamilyPhoneDevicesRepo(db);
    cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    // Online handset registered against the real-WS surface.
    const handset = devices.insert({ userId: 1, label: 'phone', kind: 'handset' });
    router.registerRealDevice(handset.id, 'handset-ws');
    onlineDevices = new Set([handset.id]);
    session = createTwilioMediaSession({ router, devices, onlineDevices });
  });

  test('start frame upserts the PSTN device and rings every online handset', () => {
    const { ws } = makeWs('twilio-1');
    session.message(ws, startFrame('+12025550100'));

    const pstnRows = db
      .prepare<{ count: number }, []>(
        "SELECT count(*) AS count FROM family_phone_devices WHERE kind='pstn'",
      )
      .get();
    expect(pstnRows?.count).toBe(1);

    const incoming = cap.sendTo.find(
      (c) => c.wsId === 'handset-ws' && c.payload['type'] === 'call:incoming',
    );
    expect(incoming).toBeDefined();
  });

  test('duplicate start on the same connection is ignored (Twilio retransmit)', () => {
    const { ws } = makeWs('twilio-1');
    session.message(ws, startFrame('+12025550100'));
    session.message(ws, startFrame('+12025550100', 'CA2', 'MZ2'));
    const incomings = cap.sendTo.filter((c) => c.payload['type'] === 'call:incoming');
    expect(incomings).toHaveLength(1);
  });

  test('non-start frames before start are dropped', () => {
    const { ws } = makeWs('twilio-1');
    session.message(ws, JSON.stringify({ event: 'connected', version: '1.0.0' }));
    session.message(ws, JSON.stringify({ event: 'media', streamSid: 'MZ', media: { track: 'inbound', payload: 'AAAA' } }));
    expect(cap.sendTo).toHaveLength(0);
  });

  test('malformed JSON is silently ignored', () => {
    const { ws } = makeWs('twilio-1');
    expect(() => session.message(ws, 'not json')).not.toThrow();
    expect(() => session.message(ws, '{"event":42}')).not.toThrow();
  });

  test('two independent connections each get their own PSTN device row and bridge', () => {
    const a = makeWs('twilio-a');
    const b = makeWs('twilio-b');
    session.message(a.ws, startFrame('+12025550100'));
    session.message(b.ws, startFrame('+12025550101'));
    const rows = db
      .prepare<{ count: number }, []>(
        "SELECT count(*) AS count FROM family_phone_devices WHERE kind='pstn'",
      )
      .get();
    expect(rows?.count).toBe(2);
  });

  test('close tears down the bridge and hangs up the live handset', () => {
    const { ws } = makeWs('twilio-1');
    session.message(ws, startFrame('+12025550100'));
    session.close(ws);
    const hungUp = cap.sendTo.find(
      (c) => c.wsId === 'handset-ws' && c.payload['type'] === 'call:hung-up',
    );
    expect(hungUp?.payload['reason']).toBe('peer-disconnect');
  });

  test('close on a connection that never started is a no-op', () => {
    const { ws } = makeWs('twilio-1');
    expect(() => session.close(ws)).not.toThrow();
  });

  test('a second start for the same E.164 returns the existing PSTN device row', () => {
    const a = makeWs('twilio-a');
    session.message(a.ws, startFrame('+12025550100'));
    session.close(a.ws);
    const b = makeWs('twilio-b');
    session.message(b.ws, startFrame('+12025550100'));
    const rows = db
      .prepare<{ count: number }, []>(
        "SELECT count(*) AS count FROM family_phone_devices WHERE kind='pstn'",
      )
      .get();
    expect(rows?.count).toBe(1);
  });
});
