#!/usr/bin/env bun
/**
 * Cross-boundary leave-a-message protocol test.
 *
 * Mirrors the shape of `e2e-family-phone-call.ts` for the voicemail-after-
 * rejected-call path the PWA exposes. Two devices pair, A calls B, B rejects,
 * A then posts a voicemail addressed to B and B's inbox surfaces it.
 *
 * Skips the real microphone — the UI sits on `client.postVoiceMessage`, and
 * this script gates that wire path. The web action wiring (open mic, capture
 * frames, send) is verified by the unit tests on the action handlers.
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
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/family-phone-leave-message');
const DB_PATH = resolve(ARTIFACTS, 'family-phone-leave-message.sqlite');
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
}

async function pairAndConnect(
  apiUrl: string,
  token: string,
  label: string,
): Promise<PairedClient> {
  const client = createEalClient(apiUrl, { token });
  const { userCode } = await client.startFamilyPhonePair();
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
    label,
    kind: 'pwa',
  });
  const conn = await client.connectFamilyPhoneDevice({ deviceId, privateKey: kp.privateKey });
  const events: FamilyPhoneCallEvent[] = [];
  conn.subscribe((e) => events.push(e));
  return { client, deviceId, conn, events };
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

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)} got ${String(actual)}`);
  }
}

async function main(): Promise<void> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await rm(DB_PATH, { force: true });
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const api = await bootApi({ database: DB_PATH });
  console.log(`[e2e] api up at ${api.url}`);
  try {
    const seed = seedCliToken({
      dbPath: DB_PATH,
      displayName: 'alex',
      label: 'family-phone-leave-message-e2e',
    });
    const alice = await pairAndConnect(api.url, seed.token, "Alex's laptop");
    const bob = await pairAndConnect(api.url, seed.token, "Alex's phone");
    console.log(`[e2e] paired devices #${alice.deviceId} and #${bob.deviceId}`);

    // A calls B; B rejects. The `call:rejected` mirror back to A is the
    // exact event the PWA hangs the "leave a message?" offer on.
    alice.conn.placeCall(bob.deviceId);
    const ack = await waitForEvent(alice.events, (e) => e.type === 'call:invite-ack');
    if (ack.type !== 'call:invite-ack') throw new Error('unreachable');
    const callId = ack.callId;
    await waitForEvent(bob.events, (e) => e.type === 'call:incoming' && e.callId === callId);
    bob.conn.rejectCall(callId);
    const rejected = await waitForEvent(
      alice.events,
      (e) => e.type === 'call:rejected' && e.callId === callId,
    );
    if (rejected.type !== 'call:rejected') throw new Error('unreachable');
    console.log(`[e2e] B rejected ${callId}, A saw the mirror event`);

    // Synthetic 24 kHz mono PCM, 100 ms — recognisable byte pattern so the
    // GET /audio round-trips byte-for-byte.
    const sampleRate = 24_000;
    const audio = new Uint8Array(sampleRate / 10);
    for (let i = 0; i < audio.length; i++) audio[i] = (0xc0 + i) & 0xff;

    const posted = await alice.client.postVoiceMessage({
      toDeviceId: bob.deviceId,
      fromDeviceId: alice.deviceId,
      body: 'Voice message',
      audio,
      sampleRate,
      channels: 1,
    });
    console.log(`[e2e] voicemail #${posted.id} posted by A → B`);

    // B's PWA refreshes its inbox; the new message must show up unread.
    const inbox = await bob.client.listVoiceMessages({ deviceId: bob.deviceId });
    const mine = inbox.find((m) => m.id === posted.id);
    if (!mine) throw new Error(`B's inbox did not surface voicemail #${posted.id}`);
    assertEqual(mine.toDeviceId, bob.deviceId, 'inbox.toDeviceId');
    assertEqual(mine.fromDeviceId, alice.deviceId, 'inbox.fromDeviceId');
    assertEqual(mine.readAt, null, 'inbox.readAt (must start unread)');

    // The /audio endpoint serves a WAV-wrapped response (44-byte RIFF header
    // + raw PCM). Strip the header to compare the bytes A sent.
    const wav = new Uint8Array(await bob.client.getVoiceMessageAudio(posted.id));
    const WAV_HEADER = 44;
    const pcm = wav.subarray(WAV_HEADER);
    if (pcm.byteLength !== audio.byteLength) {
      throw new Error(`audio byte length mismatch: posted ${audio.byteLength}, got ${pcm.byteLength}`);
    }
    for (let i = 0; i < pcm.byteLength; i++) {
      if (pcm[i] !== audio[i]) {
        throw new Error(`audio byte mismatch at offset ${i}`);
      }
    }
    console.log(`[e2e] audio round-tripped byte-for-byte`);

    // Marking read flips the flag so the "new" badge clears.
    const read = await bob.client.markVoiceMessageRead(posted.id);
    if (read.readAt === null) throw new Error('markVoiceMessageRead did not set readAt');
    console.log(`[e2e] voicemail marked read`);

    alice.conn.close();
    bob.conn.close();
    console.log(`[e2e] OK — reject → leave-a-message → callee inbox round-trip`);
  } finally {
    await api.kill();
  }
}

// Force a deterministic exit: a live WS connection keeps a reconnect timer
// pending, so a bare `await main()` prints OK but never returns control. A
// verification artefact must exit 0 on success / 1 on failure so it can be
// run in one command and trusted.
main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
