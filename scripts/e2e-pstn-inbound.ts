#!/usr/bin/env bun
/**
 * Cross-boundary verification of Phase 7B's inbound PSTN path.
 *
 * Boots the real api with TWILIO_ENABLED=true, pairs a real household
 * handset through the real client library, and then plays the role of
 * the Twilio Media Stream against the live `/api/family-phone/twilio/media`
 * WS endpoint. Asserts that:
 *
 *   1. The voice webhook returns a TwiML <Stream> response under a
 *      valid X-Twilio-Signature.
 *   2. Opening the media WS and sending `start` with the remote E.164
 *      materialises a kind='pstn' device row and rings the handset.
 *   3. Twilio→handset audio arrives at the handset as the documented
 *      24 kHz PCM payload, sized to the upsample ratio (160 PCMU bytes
 *      → 480 samples → 960 LE bytes after the 17-byte frame header).
 *   4. Handset→Twilio audio arrives upstream as a `media` event whose
 *      base64 PCMU payload is sized to the downsample ratio (480 PCM
 *      samples → 160 PCMU bytes).
 *   5. Hanging up from the handset side closes the upstream WS — the
 *      bridge's `onTerminate` fires when the live handset disconnects
 *      mid-call.
 *
 * Skips: real microphone, AudioContext, real Twilio. The Twilio media
 * stream is faked from this script's side and the audio is a known
 * synthetic byte pattern so the byte counts are deterministic. The
 * codec module's μ-law accuracy is covered by its own unit tests.
 */
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { delay } from '@eal/shared';
import { bootApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';
import { computeTwilioSignature } from '../packages/api/src/twilio/signature.ts';
import {
  createEalClient,
  type EalClient,
  type FamilyPhoneCallEvent,
  type FamilyPhoneDeviceConnection,
} from '../packages/client/src/index.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/pstn-inbound');
const DB_PATH = resolve(ARTIFACTS, 'pstn-inbound.sqlite');
const DEFAULT_TIMEOUT_MS = 5_000;

const TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000001';
const TWILIO_AUTH_TOKEN = 'e2e-auth-token';
const TWILIO_PHONE_NUMBER = '+441234567890';
const TWILIO_WEBHOOK_SIGNING_KEY = 'e2e-signing-key';
const PSTN_FROM = '+12025550100';
const CALL_SID = 'CA00000000000000000000000000000001';
const STREAM_SID = 'MZ00000000000000000000000000000001';

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
    kind: 'handset',
  });
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

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)} got ${String(actual)}`);
  }
}

interface UpstreamFrame {
  event: string;
  streamSid?: string;
  media?: { payload: string };
}

function parseUpstream(raw: string): UpstreamFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = Reflect.get(parsed, 'event');
  if (typeof event !== 'string') return null;
  const out: UpstreamFrame = { event };
  const streamSid = Reflect.get(parsed, 'streamSid');
  if (typeof streamSid === 'string') out.streamSid = streamSid;
  const media = Reflect.get(parsed, 'media');
  if (typeof media === 'object' && media !== null) {
    const payload = Reflect.get(media, 'payload');
    if (typeof payload === 'string') out.media = { payload };
  }
  return out;
}

async function main(): Promise<void> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await rm(DB_PATH, { force: true });
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  process.env['TWILIO_ENABLED'] = 'true';
  process.env['TWILIO_ACCOUNT_SID'] = TWILIO_ACCOUNT_SID;
  process.env['TWILIO_AUTH_TOKEN'] = TWILIO_AUTH_TOKEN;
  process.env['TWILIO_PHONE_NUMBER'] = TWILIO_PHONE_NUMBER;
  process.env['TWILIO_WEBHOOK_SIGNING_KEY'] = TWILIO_WEBHOOK_SIGNING_KEY;

  const api = await bootApi({ database: DB_PATH });
  console.log(`[e2e] api up at ${api.url}`);
  try {
    const seed = seedCliToken({
      dbPath: DB_PATH,
      displayName: 'alex',
      label: 'pstn-inbound-e2e',
    });

    const handset = await pairAndConnect(api.url, seed.token, "Alex's handset");
    console.log(`[e2e] handset #${handset.deviceId} paired and online`);

    // Step 1: verify the voice webhook hands back a TwiML <Stream>.
    const voicePath = '/api/family-phone/twilio/voice';
    const voiceUrl = `${api.url}${voicePath}`;
    const fields: Record<string, string> = {
      CallSid: CALL_SID,
      From: PSTN_FROM,
      To: TWILIO_PHONE_NUMBER,
      AccountSid: TWILIO_ACCOUNT_SID,
    };
    const signature = computeTwilioSignature(TWILIO_AUTH_TOKEN, voiceUrl, fields);
    const formBody = new URLSearchParams(fields).toString();
    const voiceRes = await fetch(voiceUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      body: formBody,
    });
    assertEqual(voiceRes.status, 200, 'voice webhook status');
    const twiml = await voiceRes.text();
    if (!twiml.includes('<Stream') || !twiml.includes(CALL_SID)) {
      throw new Error(`voice webhook returned unexpected body: ${twiml}`);
    }
    console.log(`[e2e] voice webhook returned TwiML with Stream + customParameters`);

    // Step 2: open the Twilio Media Stream WS.
    const wsUrl = api.url.replace(/^http/, 'ws') + '/api/family-phone/twilio/media';
    const upstream = new WebSocket(wsUrl);
    const upstreamFrames: UpstreamFrame[] = [];
    let upstreamClosed = false;
    upstream.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      const parsed = parseUpstream(data);
      if (parsed !== null) upstreamFrames.push(parsed);
    });
    upstream.addEventListener('close', () => {
      upstreamClosed = true;
    });
    await new Promise<void>((res, rej) => {
      upstream.addEventListener('open', () => res(), { once: true });
      upstream.addEventListener('error', () => rej(new Error('upstream ws error')), { once: true });
    });
    console.log(`[e2e] upstream Twilio media WS connected`);

    // Step 3: send `connected` then `start`. The handset should ring.
    upstream.send(JSON.stringify({ event: 'connected', version: '1.0.0' }));
    upstream.send(
      JSON.stringify({
        event: 'start',
        start: {
          streamSid: STREAM_SID,
          callSid: CALL_SID,
          customParameters: { from: PSTN_FROM, to: TWILIO_PHONE_NUMBER },
        },
      }),
    );
    const incoming = await waitForEvent(handset.events, (e) => e.type === 'call:incoming');
    if (incoming.type !== 'call:incoming') throw new Error('unreachable');
    const callId = incoming.callId;
    console.log(`[e2e] handset received call:incoming ${callId} from device #${incoming.fromDeviceId}`);

    handset.conn.acceptCall(callId);
    await waitForEvent(handset.events, (e) => e.type === 'call:accept-ack' && e.callId === callId);

    // Step 4: Twilio → handset audio. 160 PCMU bytes (20ms @ 8 kHz) → after
    // codec the handset's frame carries 480 Int16 samples = 960 bytes.
    const pcmuFromTwilio = new Uint8Array(160);
    for (let i = 0; i < pcmuFromTwilio.length; i++) pcmuFromTwilio[i] = (i * 11) & 0xff;
    upstream.send(
      JSON.stringify({
        event: 'media',
        streamSid: STREAM_SID,
        media: { track: 'inbound', payload: toBase64(pcmuFromTwilio) },
      }),
    );
    const recvPcm = await waitForAudio(handset.audio, callId, 960);
    assertEqual(recvPcm.payload.byteLength, 960, 'downstream PCM byte count');
    console.log(`[e2e] handset received 960-byte PCM frame from Twilio`);

    // Step 5: handset → Twilio audio. 480 samples (960 bytes) → 160 PCMU bytes
    // base64-encoded in a media event.
    const pcmFromHandset = new Uint8Array(960);
    const view = new DataView(pcmFromHandset.buffer);
    for (let i = 0; i < 480; i++) {
      const sample = Math.round(Math.sin(i / 6) * 6000);
      view.setInt16(i * 2, sample, true);
    }
    const upstreamBefore = upstreamFrames.length;
    handset.conn.sendAudio(callId, pcmFromHandset);
    await waitUntil(
      () => upstreamFrames.slice(upstreamBefore).some((f) => f.event === 'media'),
      'upstream media event from handset',
    );
    const mediaFrame = upstreamFrames.slice(upstreamBefore).find((f) => f.event === 'media');
    if (!mediaFrame || !mediaFrame.media) throw new Error('no media frame captured');
    assertEqual(mediaFrame.streamSid, STREAM_SID, 'upstream streamSid');
    const pcmuOut = fromBase64(mediaFrame.media.payload);
    assertEqual(pcmuOut.byteLength, 160, 'upstream PCMU byte count');
    console.log(`[e2e] Twilio side received 160-byte PCMU media frame from handset`);

    // Step 6: hang up from the handset; the bridge tears down and closes
    // the upstream WS.
    handset.conn.hangup(callId);
    await waitUntil(() => upstreamClosed, 'upstream WS close after handset hangup');
    console.log(`[e2e] upstream WS closed after handset hangup`);

    handset.conn.close();
    console.log(`[e2e] OK — webhook, fan-out, audio both ways, hangup all roundtripped`);
  } finally {
    await api.kill();
  }
}

await main();
