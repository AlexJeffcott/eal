import { beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DatabaseClient } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createFamilyPhoneChallengesRepo } from '../db/repos/family-phone-challenges.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import { createFamilyPhoneDeviceKeysRepo } from '../db/repos/family-phone-device-keys.ts';
import { formatSqliteDateTime } from '../auth/datetime.ts';
import {
  CHALLENGE_TTL_MS,
} from './family-phone-device-auth.shared.ts';
import { createFamilyPhoneWsHandler } from './family-phone.ws.ts';
import type { WsLike, WsService } from '../apps/types.ts';

/**
 * In-process tests for family-phone's WS handler. We don't spin up a real
 * WebSocket: the handler is a pure function over a few closures, fed
 * synthetic ws objects and a stub WsService. The framework's wiring of the
 * handler (prefix dispatch, binary tag dispatch, auth handshake) is covered
 * by server-factory.ws-seam.test.ts and the integration tests in scripts/.
 */

interface CapturedMessage {
  wsId: string;
  payload: unknown;
}
interface CapturedBinary {
  wsId: string;
  frame: Uint8Array;
}

interface Harness {
  send: CapturedMessage[];
  binary: CapturedBinary[];
  service: WsService;
  ws(id: string): WsLike;
}

function makeHarness(): Harness {
  const send: CapturedMessage[] = [];
  const binary: CapturedBinary[] = [];
  const connections = new Map<string, WsLike>();

  function ws(id: string): WsLike {
    const cached = connections.get(id);
    if (cached) return cached;
    const fresh: WsLike = {
      id,
      send(data) {
        if (typeof data === 'string') {
          send.push({ wsId: id, payload: JSON.parse(data) });
        } else {
          binary.push({ wsId: id, frame: data });
        }
      },
    };
    connections.set(id, fresh);
    return fresh;
  }

  const service: WsService = {
    sendTo(wsId, payload) {
      ws(wsId).send(JSON.stringify(payload));
    },
    sendBinaryTo(wsId, frame) {
      ws(wsId).send(frame);
    },
    subscribe() {},
    unsubscribe() {},
    broadcast() {},
    *connectedPrincipals() {},
  };
  return { send, binary, service, ws };
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const decoded = atob(padded + '='.repeat(padLen));
  const out = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
  return out;
}

interface PairedDevice {
  deviceId: number;
  privateKey: CryptoKey;
}

async function pairDeviceDirect(db: DatabaseClient, userId: number): Promise<PairedDevice> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const devices = createFamilyPhoneDevicesRepo(db);
  const keys = createFamilyPhoneDeviceKeysRepo(db);
  const device = devices.insert({ userId, label: 'd', kind: 'pwa' });
  keys.insert({ deviceId: device.id, publicKey: spki, alg: 'ES256' });
  return { deviceId: device.id, privateKey: kp.privateKey };
}

async function mintAndSign(
  db: DatabaseClient,
  device: PairedDevice,
): Promise<{ nonce: string; signature: string }> {
  const challenges = createFamilyPhoneChallengesRepo(db);
  const nonceBytes = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) nonceBytes[i] = (i * 31 + device.deviceId) & 0xff;
  const expiresAt = formatSqliteDateTime(new Date(Date.now() + CHALLENGE_TTL_MS));
  challenges.insert({ deviceId: device.deviceId, nonce: nonceBytes, expiresAt });
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    device.privateKey,
    nonceBytes,
  );
  return { nonce: toBase64Url(nonceBytes), signature: toBase64Url(new Uint8Array(sig)) };
}

async function authConnect(
  handler: ReturnType<typeof createFamilyPhoneWsHandler>,
  ws: WsLike,
  db: DatabaseClient,
  device: PairedDevice,
): Promise<void> {
  const { nonce, signature } = await mintAndSign(db, device);
  const ok = await handler.authenticate?.(ws, {
    type: 'auth',
    device_id: device.deviceId,
    nonce,
    signature,
  });
  expect(ok).toBe(true);
}

describe('family-phone.ws — authenticate', () => {
  let db: DatabaseClient;
  let userId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    userId = createUsersRepo(db).insert({ displayName: 'alex' }).id;
  });

  test('an envelope missing device_id is declined (false)', async () => {
    const harness = makeHarness();
    const handler = createFamilyPhoneWsHandler({ db, ws: harness.service }, new Set(), "test-topic");
    const ok = await handler.authenticate?.(harness.ws('a'), { type: 'auth' });
    expect(ok).toBe(false);
  });

  test('a valid challenge/signature pair is accepted', async () => {
    const harness = makeHarness();
    const handler = createFamilyPhoneWsHandler({ db, ws: harness.service }, new Set(), "test-topic");
    const device = await pairDeviceDirect(db, userId);
    await authConnect(handler, harness.ws('a'), db, device);
  });

  test('a bad signature is declined (false), no exception', async () => {
    const harness = makeHarness();
    const handler = createFamilyPhoneWsHandler({ db, ws: harness.service }, new Set(), "test-topic");
    const device = await pairDeviceDirect(db, userId);
    const { nonce } = await mintAndSign(db, device);

    // Sign with an unrelated key — must produce false, not throw.
    const otherKp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const badSig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      otherKp.privateKey,
      fromBase64Url(nonce),
    );
    const ok = await handler.authenticate?.(harness.ws('a'), {
      type: 'auth',
      device_id: device.deviceId,
      nonce,
      signature: toBase64Url(new Uint8Array(badSig)),
    });
    expect(ok).toBe(false);
  });
});

describe('family-phone.ws — call state machine, two authed peers', () => {
  let db: DatabaseClient;
  let alexId: number;
  let elisaId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    applySchema(db);
    alexId = createUsersRepo(db).insert({ displayName: 'alex' }).id;
    elisaId = createUsersRepo(db).insert({ displayName: 'elisa' }).id;
  });

  async function setup() {
    const harness = makeHarness();
    const handler = createFamilyPhoneWsHandler({ db, ws: harness.service }, new Set(), "test-topic");
    const alex = await pairDeviceDirect(db, alexId);
    const elisa = await pairDeviceDirect(db, elisaId);
    const wsA = harness.ws('alex-ws');
    const wsE = harness.ws('elisa-ws');
    await authConnect(handler, wsA, db, alex);
    await authConnect(handler, wsE, db, elisa);
    harness.send.length = 0;
    harness.binary.length = 0;
    return { harness, handler, alex, elisa, wsA, wsE };
  }

  function find(
    captures: CapturedMessage[],
    wsId: string,
    type: string,
  ): Record<string, unknown> | null {
    for (const c of captures) {
      if (c.wsId !== wsId) continue;
      if (typeof c.payload !== 'object' || c.payload === null) continue;
      if (!('type' in c.payload)) continue;
      if (c.payload.type === type) {
        if (typeof c.payload === 'object' && c.payload !== null) {
          return c.payload as Record<string, unknown>;
        }
      }
    }
    return null;
  }

  test('invite → accept → hangup happy path delivers each transition to the peer', async () => {
    const { harness, handler, alex, elisa, wsA, wsE } = await setup();

    handler.onMessage(wsA, { type: 'call:invite', target_device_id: elisa.deviceId }, null);
    const ack = find(harness.send, 'alex-ws', 'call:invite-ack');
    expect(ack).not.toBeNull();
    const callId = ack?.['call_id'];
    expect(typeof callId).toBe('string');

    const incoming = find(harness.send, 'elisa-ws', 'call:incoming');
    expect(incoming?.['call_id']).toBe(callId);
    expect(incoming?.['from_device_id']).toBe(alex.deviceId);

    handler.onMessage(wsE, { type: 'call:accept', call_id: callId }, null);
    expect(find(harness.send, 'alex-ws', 'call:accepted')?.['call_id']).toBe(callId);
    expect(find(harness.send, 'elisa-ws', 'call:accept-ack')?.['call_id']).toBe(callId);

    handler.onMessage(wsA, { type: 'call:hangup', call_id: callId }, null);
    expect(find(harness.send, 'elisa-ws', 'call:hung-up')?.['call_id']).toBe(callId);
  });

  test('reject from callee closes the call without going through connected', async () => {
    const { harness, handler, elisa, wsA, wsE } = await setup();
    handler.onMessage(wsA, { type: 'call:invite', target_device_id: elisa.deviceId }, null);
    const callId = find(harness.send, 'alex-ws', 'call:invite-ack')?.['call_id'];
    expect(typeof callId).toBe('string');

    handler.onMessage(wsE, { type: 'call:reject', call_id: callId }, null);
    expect(find(harness.send, 'alex-ws', 'call:rejected')?.['call_id']).toBe(callId);

    // A subsequent hangup attempt on a closed call is a no-op.
    harness.send.length = 0;
    handler.onMessage(wsA, { type: 'call:hangup', call_id: callId }, null);
    expect(harness.send.length).toBe(0);
  });

  test('cancel from caller closes a pending call and notifies the callee', async () => {
    const { harness, handler, elisa, wsA } = await setup();
    handler.onMessage(wsA, { type: 'call:invite', target_device_id: elisa.deviceId }, null);
    const callId = find(harness.send, 'alex-ws', 'call:invite-ack')?.['call_id'];

    handler.onMessage(wsA, { type: 'call:cancel', call_id: callId }, null);
    expect(find(harness.send, 'elisa-ws', 'call:cancelled')?.['call_id']).toBe(callId);
  });

  test('the callee cannot accept its own call (only the callee can)', async () => {
    const { harness, handler, elisa, wsA } = await setup();
    handler.onMessage(wsA, { type: 'call:invite', target_device_id: elisa.deviceId }, null);
    const callId = find(harness.send, 'alex-ws', 'call:invite-ack')?.['call_id'];

    // Caller tries to "accept" their own call — ignored.
    harness.send.length = 0;
    handler.onMessage(wsA, { type: 'call:accept', call_id: callId }, null);
    expect(harness.send.length).toBe(0);
  });

  test('simultaneous hangups collapse to a single closed transition', async () => {
    const { harness, handler, elisa, wsA, wsE } = await setup();
    handler.onMessage(wsA, { type: 'call:invite', target_device_id: elisa.deviceId }, null);
    const callId = find(harness.send, 'alex-ws', 'call:invite-ack')?.['call_id'];
    handler.onMessage(wsE, { type: 'call:accept', call_id: callId }, null);

    harness.send.length = 0;
    handler.onMessage(wsA, { type: 'call:hangup', call_id: callId }, null);
    handler.onMessage(wsE, { type: 'call:hangup', call_id: callId }, null);

    // Only the first hangup propagates to the peer; the second sees the
    // call already closed and is a no-op.
    const hungUps = harness.send.filter((c) => {
      return (
        typeof c.payload === 'object' &&
        c.payload !== null &&
        'type' in c.payload &&
        c.payload.type === 'call:hung-up'
      );
    });
    expect(hungUps.length).toBe(1);
  });

  test('invite to an offline target returns invite-failed', async () => {
    const { harness, handler, wsA } = await setup();
    handler.onMessage(wsA, { type: 'call:invite', target_device_id: 9999 }, null);
    expect(find(harness.send, 'alex-ws', 'call:invite-failed')).not.toBeNull();
  });

  test('audio frame on a connected call is forwarded byte-for-byte to the peer', async () => {
    const { harness, handler, elisa, wsA, wsE } = await setup();
    handler.onMessage(wsA, { type: 'call:invite', target_device_id: elisa.deviceId }, null);
    const callId = find(harness.send, 'alex-ws', 'call:invite-ack')?.['call_id'];
    if (typeof callId !== 'string') throw new Error('no call_id');
    handler.onMessage(wsE, { type: 'call:accept', call_id: callId }, null);

    // Frame: [0x10][16-byte ASCII callId, zero-padded][opus payload]
    const frame = new Uint8Array(new ArrayBuffer(1 + 16 + 4));
    frame[0] = 0x10;
    const cid = new TextEncoder().encode(callId).slice(0, 16);
    frame.set(cid, 1);
    frame[17] = 0xde;
    frame[18] = 0xad;
    frame[19] = 0xbe;
    frame[20] = 0xef;

    harness.binary.length = 0;
    handler.onBinary?.(wsA, frame, null);
    expect(harness.binary.length).toBe(1);
    expect(harness.binary[0]?.wsId).toBe('elisa-ws');
    expect(harness.binary[0]?.frame).toEqual(frame);
  });

  test('audio frame on a closed call is dropped, never forwarded', async () => {
    const { harness, handler, elisa, wsA, wsE } = await setup();
    handler.onMessage(wsA, { type: 'call:invite', target_device_id: elisa.deviceId }, null);
    const callId = find(harness.send, 'alex-ws', 'call:invite-ack')?.['call_id'];
    if (typeof callId !== 'string') throw new Error('no call_id');
    handler.onMessage(wsE, { type: 'call:accept', call_id: callId }, null);
    handler.onMessage(wsA, { type: 'call:hangup', call_id: callId }, null);

    const frame = new Uint8Array(new ArrayBuffer(1 + 16 + 4));
    frame[0] = 0x10;
    frame.set(new TextEncoder().encode(callId).slice(0, 16), 1);

    harness.binary.length = 0;
    handler.onBinary?.(wsA, frame, null);
    expect(harness.binary.length).toBe(0);
  });

  test('peer disconnect mid-call surfaces call:hung-up with reason=peer-disconnect', async () => {
    const { harness, handler, elisa, wsA, wsE } = await setup();
    handler.onMessage(wsA, { type: 'call:invite', target_device_id: elisa.deviceId }, null);
    const callId = find(harness.send, 'alex-ws', 'call:invite-ack')?.['call_id'];
    handler.onMessage(wsE, { type: 'call:accept', call_id: callId }, null);

    harness.send.length = 0;
    handler.onClose?.(wsE);
    const hungUp = find(harness.send, 'alex-ws', 'call:hung-up');
    expect(hungUp?.['call_id']).toBe(callId);
    expect(hungUp?.['reason']).toBe('peer-disconnect');
  });
});
