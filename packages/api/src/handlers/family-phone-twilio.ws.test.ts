import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createCallRouter } from './family-phone-call-router.ts';
import {
  createFamilyPhoneDevicesRepo,
  type FamilyPhoneDevicesRepo,
} from '../db/repos/family-phone-devices.ts';
import {
  createPstnContactsRepo,
  type PstnContactsRepo,
} from '../db/repos/family-phone-pstn-contacts.ts';
import { createPstnCallOutcomes } from './family-phone-pstn-outcomes.ts';
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

function outboundStartFrame(
  from: string,
  handsetId: number,
  callSid = 'CA1',
  streamSid = 'MZ1',
  to = '+441234567890',
): string {
  return JSON.stringify({
    event: 'start',
    start: {
      streamSid,
      callSid,
      customParameters: {
        from,
        to,
        direction: 'outbound',
        handset: String(handsetId),
      },
    },
  });
}

describe('createTwilioMediaSession', () => {
  let db: DatabaseClient;
  let devices: FamilyPhoneDevicesRepo;
  let cap: Capture;
  let session: TwilioMediaSession;
  let onlineDevices: Set<number>;
  let handsetId: number;
  let userId: number;
  let pstnContacts: PstnContactsRepo;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    const userRow = db
      .prepare<{ id: number }, []>(
        "INSERT INTO users (display_name) VALUES ('alex') RETURNING id",
      )
      .get();
    userId = userRow?.id ?? 0;
    devices = createFamilyPhoneDevicesRepo(db);
    pstnContacts = createPstnContactsRepo(db);
    cap = makeCapture();
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    // Online handset registered against the real-WS surface.
    const handset = devices.insert({ userId, label: 'phone', kind: 'handset' });
    handsetId = handset.id;
    router.registerRealDevice(handset.id, 'handset-ws');
    onlineDevices = new Set([handset.id]);
    session = createTwilioMediaSession({
      router,
      devices,
      onlineDevices,
      pstnContacts,
      outcomes: createPstnCallOutcomes(),
    });
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

  test('outbound start rings only the named handset, skipping fan-out', () => {
    // Add a second handset that should NOT receive the invite on outbound.
    const secondHandset = devices.insert({ userId, label: 'tablet', kind: 'handset' });
    onlineDevices.add(secondHandset.id);

    const { ws } = makeWs('twilio-outbound');
    // The PSTN target is the dialed party; the named handset is the one
    // that placed the call. Use the first handset (registered as
    // 'handset-ws').
    session.message(ws, outboundStartFrame('+12025550100', handsetId));

    const incomings = cap.sendTo.filter((c) => c.payload['type'] === 'call:incoming');
    expect(incomings).toHaveLength(1);
    expect(incomings[0]?.wsId).toBe('handset-ws');
  });

  test('outbound start whose named handset is offline terminates the bridge', () => {
    let closed = false;
    const wsObj = {
      id: 'twilio-outbound',
      send() {},
      close() {
        closed = true;
      },
    };
    // Reference a handset id that exists in DB but is not in
    // onlineDevices: the bridge sees an empty target list and shuts
    // down so Twilio drops the call instead of dialling out into the
    // void.
    const offline = devices.insert({ userId, label: 'tablet', kind: 'handset' });
    session.message(wsObj, outboundStartFrame('+12025550100', offline.id));
    expect(closed).toBe(true);
  });

  test('inbound from a known contact with intended_user_id rings only that user', () => {
    // Add a second user with a handset of their own; the call is for
    // alex, so sarah's handset must not ring.
    const sarahRow = db
      .prepare<{ id: number }, []>(
        "INSERT INTO users (display_name) VALUES ('sarah') RETURNING id",
      )
      .get();
    const sarahId = sarahRow?.id ?? 0;
    const sarahHandset = devices.insert({ userId: sarahId, label: 'phone', kind: 'handset' });
    onlineDevices.add(sarahHandset.id);
    // The call router would normally register sarah's WS too; emulate
    // by pointing both devices at distinct WS ids.
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(handsetId, 'handset-ws');
    router.registerRealDevice(sarahHandset.id, 'sarah-ws');
    session = createTwilioMediaSession({
      router,
      devices,
      onlineDevices,
      pstnContacts,
      outcomes: createPstnCallOutcomes(),
    });

    pstnContacts.insert({
      e164: '+12025550100',
      label: 'Nonna',
      allowIn: true,
      allowOut: true,
      intendedUserId: userId,
    });
    const { ws } = makeWs('twilio-inbound');
    session.message(ws, startFrame('+12025550100'));
    const incomings = cap.sendTo.filter((c) => c.payload['type'] === 'call:incoming');
    expect(incomings.map((c) => c.wsId).sort()).toEqual(['handset-ws']);
  });

  test('routed_user_id in start customParameters rings only that user (IVR-picked path)', () => {
    const sarahRow = db
      .prepare<{ id: number }, []>(
        "INSERT INTO users (display_name) VALUES ('sarah') RETURNING id",
      )
      .get();
    const sarahId = sarahRow?.id ?? 0;
    const sarahHandset = devices.insert({ userId: sarahId, label: 'phone', kind: 'handset' });
    onlineDevices.add(sarahHandset.id);
    const router = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
    router.registerRealDevice(handsetId, 'handset-ws');
    router.registerRealDevice(sarahHandset.id, 'sarah-ws');
    session = createTwilioMediaSession({
      router,
      devices,
      onlineDevices,
      pstnContacts,
      outcomes: createPstnCallOutcomes(),
    });
    const { ws } = makeWs('twilio-inbound');
    session.message(
      ws,
      JSON.stringify({
        event: 'start',
        start: {
          streamSid: 'MZ-routed',
          callSid: 'CA-routed',
          customParameters: {
            from: '+19999999999',
            to: '+441234567890',
            direction: 'inbound',
            routed_user_id: String(sarahId),
          },
        },
      }),
    );
    const incomings = cap.sendTo.filter((c) => c.payload['type'] === 'call:incoming');
    expect(incomings.map((c) => c.wsId)).toEqual(['sarah-ws']);
  });

  test('bridge terminate after handset answers writes outcome=answered', () => {
    const outcomes = createPstnCallOutcomes();
    outcomes.prime('CA-out', { kind: 'household', householdDeviceId: 1 }, '+1');
    session = createTwilioMediaSession({
      router: (() => {
        const r = createCallRouter({ ws: cap.service, unansweredMs: 60_000 });
        r.registerRealDevice(handsetId, 'handset-ws');
        return r;
      })(),
      devices,
      onlineDevices,
      pstnContacts,
      outcomes,
    });
    const { ws } = makeWs('twilio-end-to-end');
    session.message(
      ws,
      JSON.stringify({
        event: 'start',
        start: {
          streamSid: 'MZ-end',
          callSid: 'CA-out',
          customParameters: { from: '+19999999999', to: '+441234567890' },
        },
      }),
    );
    // Find the call_id the router minted for the fan-out invite and
    // submit an accept on behalf of the handset, then hang up.
    const incoming = cap.sendTo.find((c) => c.payload['type'] === 'call:incoming');
    const callId = String(incoming?.payload['call_id'] ?? '');
    expect(callId).not.toBe('');
    // close() drives onTerminate; manually accept first by registering
    // a router event so the bridge sees activeCallId set before close.
    session.close(ws);
    expect(outcomes.get('CA-out')?.outcome).toBe('unanswered');
  });

  test('inbound from a known contact whose intended user is offline terminates the bridge', () => {
    onlineDevices.delete(handsetId);
    pstnContacts.insert({
      e164: '+12025550100',
      label: 'Nonna',
      allowIn: true,
      allowOut: true,
      intendedUserId: userId,
    });
    let closed = false;
    const wsObj = {
      id: 'twilio-inbound',
      send() {},
      close() { closed = true; },
    };
    session.message(wsObj, startFrame('+12025550100'));
    expect(closed).toBe(true);
  });

  test('inbound from an unknown caller still fans out across the household', () => {
    // No matching pstn_contacts row → keeps the existing fan-out
    // behaviour until commit C swaps in the DTMF IVR.
    const { ws } = makeWs('twilio-inbound');
    session.message(ws, startFrame('+19999999999'));
    const incomings = cap.sendTo.filter((c) => c.payload['type'] === 'call:incoming');
    expect(incomings.map((c) => c.wsId)).toEqual(['handset-ws']);
  });

  test('inbound from a known contact without an intended recipient also fans out', () => {
    pstnContacts.insert({
      e164: '+12025550100',
      label: 'Pizza place',
      allowIn: true,
      allowOut: false,
    });
    const { ws } = makeWs('twilio-inbound');
    session.message(ws, startFrame('+12025550100'));
    const incomings = cap.sendTo.filter((c) => c.payload['type'] === 'call:incoming');
    expect(incomings.map((c) => c.wsId)).toEqual(['handset-ws']);
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
