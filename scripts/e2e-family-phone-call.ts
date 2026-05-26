#!/usr/bin/env bun
/**
 * Cross-boundary family-phone protocol test.
 *
 * The shape required by ~/projects/CLAUDE.md ("Green checks do not prove
 * features work"): drives the real api process and the real client library
 * end-to-end. No stubs, no UI assumptions. Two EalClient instances pair
 * themselves as separate devices, open their device WebSockets, place a
 * call between them, exchange synthetic audio frames, and hang up. Every
 * step asserts the wire-level outcome.
 *
 * Skips: real microphone, AudioContext, browser DOM. Those are wired in
 * the web app but each has its own iteration cycle; this script gates the
 * server protocol and the @eal/client library, which is what the UI sits
 * on top of.
 */
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { delay } from '@eal/shared';
import { bootApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';
import {
  createEalClient,
  type EalClient,
  type FamilyPhoneCallEvent,
  type FamilyPhoneDeviceConnection,
} from '../packages/client/src/index.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/family-phone-call');
const DB_PATH = resolve(ARTIFACTS, 'family-phone-call.sqlite');
const DEFAULT_TIMEOUT_MS = 5_000;

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface PairedClient {
  client: EalClient;
  deviceId: number;
  conn: FamilyPhoneDeviceConnection;
  events: FamilyPhoneCallEvent[];
  audio: { callId: string; payload: Uint8Array }[];
}

async function pairAndConnect(
  apiUrl: string,
  token: string,
  label: string,
): Promise<PairedClient> {
  const client = createEalClient(apiUrl, { token });
  // Trusted-device side: mint a code.
  const { userCode } = await client.startFamilyPhonePair({ label, kind: 'pwa' });
  // New-device side: generate a keypair, submit the code + public key.
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const { deviceId } = await client.completeFamilyPhonePair({
    userCode,
    publicKey: toBase64Url(spki),
    alg: 'ES256',
  });
  // Open the device WS using the freshly-generated private key.
  const conn = await client.connectFamilyPhoneDevice({ deviceId, privateKey: kp.privateKey });
  const events: FamilyPhoneCallEvent[] = [];
  const audio: { callId: string; payload: Uint8Array }[] = [];
  conn.subscribe((e) => events.push(e));
  conn.subscribeAudio((callId, payload) => audio.push({ callId, payload }));
  return { client, deviceId, conn, events, audio };
}

async function waitForEvent(
  bag: FamilyPhoneCallEvent[],
  predicate: (e: FamilyPhoneCallEvent) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FamilyPhoneCallEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = bag.find(predicate);
    if (found) return found;
    await delay(25);
  }
  throw new Error(`timed out waiting for event in ${JSON.stringify(bag)}`);
}

async function waitForAudio(
  bag: { callId: string; payload: Uint8Array }[],
  callId: string,
  minLen: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ callId: string; payload: Uint8Array }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = bag.find((a) => a.callId === callId && a.payload.byteLength >= minLen);
    if (found) return found;
    await delay(25);
  }
  throw new Error(`timed out waiting for audio frame on ${callId}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)} got ${String(actual)}`);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function main(): Promise<void> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await rm(DB_PATH, { force: true });
  // The api binds with a local TLS cert; the harness trusts it for the
  // duration of this script. Production never sets this.
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const api = await bootApi({ database: DB_PATH });
  console.log(`[e2e] api up at ${api.url}`);
  try {
    // Same user can own multiple devices — the household model lets one
    // human be present on a laptop and a handset simultaneously.
    const seed = seedCliToken({
      dbPath: DB_PATH,
      displayName: 'alex',
      label: 'family-phone-e2e',
    });
    console.log(`[e2e] seeded user #${seed.userId}`);

    const alice = await pairAndConnect(api.url, seed.token, "Alex's laptop");
    const bob = await pairAndConnect(api.url, seed.token, "Alex's phone");
    console.log(`[e2e] paired devices #${alice.deviceId} and #${bob.deviceId}`);

    // Place a call from alice → bob.
    alice.conn.placeCall(bob.deviceId);
    const ack = await waitForEvent(alice.events, (e) => e.type === 'call:invite-ack');
    if (ack.type !== 'call:invite-ack') throw new Error('unreachable');
    const callId = ack.callId;
    console.log(`[e2e] call ${callId} invited`);

    const incoming = await waitForEvent(bob.events, (e) => e.type === 'call:incoming');
    if (incoming.type !== 'call:incoming') throw new Error('unreachable');
    assertEqual(incoming.callId, callId, 'incoming.callId');
    assertEqual(incoming.fromDeviceId, alice.deviceId, 'incoming.fromDeviceId');

    // Accept and verify both sides reach `connected`.
    bob.conn.acceptCall(callId);
    await waitForEvent(alice.events, (e) => e.type === 'call:accepted' && e.callId === callId);
    await waitForEvent(bob.events, (e) => e.type === 'call:accept-ack' && e.callId === callId);
    console.log(`[e2e] both peers connected`);

    // Audio loop: send a recognisable byte pattern each way.
    const payloadAtoB = new Uint8Array(new ArrayBuffer(64));
    for (let i = 0; i < 64; i++) payloadAtoB[i] = (0xa0 + i) & 0xff;
    alice.conn.sendAudio(callId, payloadAtoB);
    const recvAtoB = await waitForAudio(bob.audio, callId, 64);
    if (!bytesEqual(recvAtoB.payload, payloadAtoB)) {
      throw new Error('audio frame A→B did not arrive byte-identical');
    }

    const payloadBtoA = new Uint8Array(new ArrayBuffer(48));
    for (let i = 0; i < 48; i++) payloadBtoA[i] = (0xb0 + i) & 0xff;
    bob.conn.sendAudio(callId, payloadBtoA);
    const recvBtoA = await waitForAudio(alice.audio, callId, 48);
    if (!bytesEqual(recvBtoA.payload, payloadBtoA)) {
      throw new Error('audio frame B→A did not arrive byte-identical');
    }
    console.log(`[e2e] audio frames roundtripped byte-for-byte`);

    // Hang up from alice; bob should see it.
    alice.conn.hangup(callId);
    const hangup = await waitForEvent(bob.events, (e) => e.type === 'call:hung-up' && e.callId === callId);
    if (hangup.type !== 'call:hung-up') throw new Error('unreachable');
    console.log(`[e2e] hangup delivered`);

    alice.conn.close();
    bob.conn.close();
    console.log(`[e2e] OK — pair, call, audio, hangup all roundtripped`);
  } finally {
    await api.kill();
  }
}

await main();
