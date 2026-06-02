#!/usr/bin/env bun
/**
 * Cross-boundary verification of Phase 7C's outbound PSTN path.
 *
 * Boots the real api with TWILIO_ENABLED=true plus a TWILIO_API_BASE_URL
 * pointing at a local stub that plays the role of Twilio's REST API.
 * Pairs a real household handset through the real client library, then
 * walks the full dial-out round-trip:
 *
 *   1. The handset sends `call:place-pstn` over its authed WS. The api
 *      hits the stub Twilio with the form-encoded `From=Twilio number /
 *      To=dialed E.164 / Url=TwiML callback`, gets a queued CallSid back,
 *      and delivers `call:place-pstn-ack` carrying that CallSid to the
 *      handset. Authoritative side-effect: the dialed E.164 is upserted
 *      as a kind='pstn' device row before Twilio is even asked.
 *
 *   2. The TwiML callback URL the api handed Twilio carries
 *      `direction=outbound&handset=<id>` in its query string. Fetching
 *      it (under a valid X-Twilio-Signature) returns a `<Connect><Stream>`
 *      TwiML whose `<Parameter>` tags carry `direction=outbound`, the
 *      placing handset's id, the originating CallSid, and Twilio's
 *      From/To fields. The bridge keys its outbound-vs-inbound branch
 *      on those parameters.
 *
 *   3. Opening the upstream Media Stream WS with that exact `start` frame
 *      makes the bridge bind the stream to the placing handset (no fan-
 *      out — fan-out would ring uninvolved household devices). The
 *      handset receives `call:incoming`; the dial-pad UI's auto-accept
 *      latch (verified by unit tests) routes through the same
 *      `acceptCall(callId)` we send here from the script.
 *
 *   4. Once accepted, audio flows both ways through the bridge with the
 *      same μ-law ↔ 24 kHz PCM codec the 7B inbound script exercises.
 *      Asserting byte counts proves the bridge is wired symmetrically:
 *      a 160-byte PCMU upstream frame lands at the handset as 960 PCM
 *      bytes, and a 960-byte PCM handset frame lands upstream as a 160-
 *      byte PCMU base64 payload.
 *
 *   5. Hanging up from the handset closes the upstream WS — the bridge's
 *      onTerminate fires when the live handset disconnects mid-call.
 *
 * Skips: real Twilio (the REST API is a Bun.serve stub bound to a random
 * port and pointed at via TWILIO_API_BASE_URL), real microphone, real
 * AudioContext. The audio payloads are deterministic synthetic bytes so
 * the round-trip byte counts are exact.
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
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/pstn-outbound');
const DB_PATH = resolve(ARTIFACTS, 'pstn-outbound.sqlite');
const DEFAULT_TIMEOUT_MS = 5_000;

const TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000002';
const TWILIO_AUTH_TOKEN = 'e2e-outbound-auth-token';
const TWILIO_PHONE_NUMBER = '+441234567890';
const TWILIO_WEBHOOK_SIGNING_KEY = 'e2e-outbound-signing-key';
const PSTN_TO = '+12025550199';
const CALL_SID = 'CA00000000000000000000000000000002';
const STREAM_SID = 'MZ00000000000000000000000000000002';

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

interface CapturedTwilioCall {
  url: string;
  authorization: string;
  contentType: string;
  fields: Record<string, string>;
}

interface FakeTwilio {
  url: string;
  calls: CapturedTwilioCall[];
  stop: () => Promise<void>;
}

/**
 * Stand-in for Twilio's REST API. Only the one endpoint the trunk uses
 * is implemented — POST `/2010-04-01/Accounts/{SID}/Calls.json`. Every
 * other path returns 404 so a typo in the URL the api builds shows up
 * loudly. Returns a `queued` CallSid response that matches Twilio's
 * documented shape so the REST client's parser hits its happy path.
 */
function startFakeTwilio(): FakeTwilio {
  const calls: CapturedTwilioCall[] = [];
  const callsPathSuffix = `/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname.endsWith(callsPathSuffix)) {
        const raw = await req.text();
        const params = new URLSearchParams(raw);
        const fields: Record<string, string> = {};
        for (const [k, v] of params.entries()) fields[k] = v;
        calls.push({
          url: req.url,
          authorization: req.headers.get('authorization') ?? '',
          contentType: req.headers.get('content-type') ?? '',
          fields,
        });
        return Response.json({ sid: CALL_SID, status: 'queued' }, { status: 201 });
      }
      return new Response(`not found: ${req.method} ${url.pathname}`, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/2010-04-01`,
    calls,
    stop: async (): Promise<void> => {
      await server.stop(true);
    },
  };
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

  const twilio = startFakeTwilio();
  console.log(`[e2e] fake Twilio REST up at ${twilio.url}`);
  process.env['TWILIO_API_BASE_URL'] = twilio.url;

  const api = await bootApi({ database: DB_PATH });
  console.log(`[e2e] api up at ${api.url}`);
  try {
    const seed = seedCliToken({
      dbPath: DB_PATH,
      displayName: 'alex',
      label: 'pstn-outbound-e2e',
    });

    const handset = await pairAndConnect(api.url, seed.token, "Alex's handset");
    console.log(`[e2e] handset #${handset.deviceId} paired and online`);

    // Step 1: handset taps Call → the api hits the fake Twilio.
    handset.conn.placePstn(PSTN_TO);
    const ack = await waitForEvent(handset.events, (e) => e.type === 'call:place-pstn-ack');
    if (ack.type !== 'call:place-pstn-ack') throw new Error('unreachable');
    assertEqual(ack.callSid, CALL_SID, 'place-pstn-ack callSid');
    assertEqual(twilio.calls.length, 1, 'Twilio REST call count');
    const tcall = twilio.calls[0]!;
    if (!tcall.authorization.startsWith('Basic ')) {
      throw new Error(`Twilio REST authorization not Basic: ${tcall.authorization}`);
    }
    const expectedBasic = `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`;
    assertEqual(tcall.authorization, expectedBasic, 'Twilio REST Basic auth');
    assertEqual(tcall.contentType, 'application/x-www-form-urlencoded', 'Twilio REST content-type');
    assertEqual(tcall.fields['From'], TWILIO_PHONE_NUMBER, 'Twilio REST From');
    assertEqual(tcall.fields['To'], PSTN_TO, 'Twilio REST To');
    const twimlUrl = tcall.fields['Url'] ?? '';
    if (twimlUrl === '') throw new Error('Twilio REST missing Url field');
    const parsedTwimlUrl = new URL(twimlUrl);
    assertEqual(parsedTwimlUrl.pathname, '/api/family-phone/twilio/voice', 'TwiML URL path');
    assertEqual(parsedTwimlUrl.searchParams.get('direction'), 'outbound', 'TwiML URL direction');
    assertEqual(
      parsedTwimlUrl.searchParams.get('handset'),
      String(handset.deviceId),
      'TwiML URL handset',
    );
    console.log(`[e2e] handset → api → Twilio: ack ${ack.callSid}, TwiML URL ${twimlUrl}`);

    // Step 2: simulate Twilio fetching the TwiML callback. Hit our own
    // api host directly — what Twilio would do, but without the public
    // Funnel hop. The signature is computed against the URL Twilio
    // would actually dial (i.e. the one in the REST request).
    const apiHost = new URL(api.url).host;
    const localTwimlUrl = twimlUrl
      .replace(/^https?:\/\/[^/]+/, api.url.replace(/\/$/, ''))
      .replace(new URL(twimlUrl).host, apiHost);
    const voiceFields: Record<string, string> = {
      CallSid: CALL_SID,
      AccountSid: TWILIO_ACCOUNT_SID,
      From: TWILIO_PHONE_NUMBER,
      To: PSTN_TO,
    };
    // Twilio signs the URL it dialled — that's the one the REST client
    // handed it (twimlUrl), regardless of which host the script hits.
    const signature = computeTwilioSignature(TWILIO_AUTH_TOKEN, twimlUrl, voiceFields);
    const voiceRes = await fetch(localTwimlUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
        // Trick the signature verifier into reconstructing the exact
        // URL Twilio signed: forward the original host so request.url
        // matches twimlUrl byte-for-byte.
        host: new URL(twimlUrl).host,
      },
      body: new URLSearchParams(voiceFields).toString(),
    });
    assertEqual(voiceRes.status, 200, 'voice webhook status');
    const twiml = await voiceRes.text();
    if (!twiml.includes('<Stream')) throw new Error(`voice webhook missing Stream: ${twiml}`);
    if (!twiml.includes('name="direction" value="outbound"')) {
      throw new Error(`voice webhook missing direction=outbound: ${twiml}`);
    }
    if (!twiml.includes(`name="handset" value="${handset.deviceId}"`)) {
      throw new Error(`voice webhook missing handset=${handset.deviceId}: ${twiml}`);
    }
    if (!twiml.includes(`name="callSid" value="${CALL_SID}"`)) {
      throw new Error(`voice webhook missing callSid=${CALL_SID}: ${twiml}`);
    }
    console.log(`[e2e] voice webhook returned outbound TwiML with handset=${handset.deviceId}`);

    // Step 3: open the upstream Twilio Media Stream WS and send the
    // outbound `start` frame the bridge keys its binding on.
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

    upstream.send(JSON.stringify({ event: 'connected', version: '1.0.0' }));
    upstream.send(
      JSON.stringify({
        event: 'start',
        start: {
          streamSid: STREAM_SID,
          callSid: CALL_SID,
          customParameters: {
            callSid: CALL_SID,
            from: TWILIO_PHONE_NUMBER,
            to: PSTN_TO,
            direction: 'outbound',
            handset: String(handset.deviceId),
          },
        },
      }),
    );

    // Step 4: handset receives call:incoming (bridge bound to this
    // handset only — no fan-out on outbound). The dial-pad UI auto-
    // accepts in this state; here we exercise the same `acceptCall`
    // path the UI would.
    const incoming = await waitForEvent(handset.events, (e) => e.type === 'call:incoming');
    if (incoming.type !== 'call:incoming') throw new Error('unreachable');
    const callId = incoming.callId;
    console.log(`[e2e] handset received call:incoming ${callId} from device #${incoming.fromDeviceId}`);
    handset.conn.acceptCall(callId);
    await waitForEvent(handset.events, (e) => e.type === 'call:accept-ack' && e.callId === callId);

    // Step 5: Twilio → handset audio. 160-byte PCMU frame upsamples to
    // 480 PCM samples = 960 bytes payload at the handset.
    const pcmuFromTwilio = new Uint8Array(160);
    for (let i = 0; i < pcmuFromTwilio.length; i++) pcmuFromTwilio[i] = (i * 13) & 0xff;
    upstream.send(
      JSON.stringify({
        event: 'media',
        streamSid: STREAM_SID,
        media: { track: 'inbound', payload: toBase64(pcmuFromTwilio) },
      }),
    );
    const recvPcm = await waitForAudio(handset.audio, callId, 960);
    assertEqual(recvPcm.payload.byteLength, 960, 'downstream PCM byte count');
    console.log(`[e2e] handset received 960-byte PCM frame from upstream`);

    // Step 6: handset → Twilio audio. 480 PCM samples (960 bytes)
    // downsamples to 160 PCMU bytes in a base64-encoded media event.
    const pcmFromHandset = new Uint8Array(960);
    const view = new DataView(pcmFromHandset.buffer);
    for (let i = 0; i < 480; i++) {
      const sample = Math.round(Math.cos(i / 7) * 6000);
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
    console.log(`[e2e] upstream received 160-byte PCMU media frame from handset`);

    // Step 7: hang up from the handset; the bridge closes the upstream
    // WS so Twilio drops the call.
    handset.conn.hangup(callId);
    await waitUntil(() => upstreamClosed, 'upstream WS close after handset hangup');
    console.log(`[e2e] upstream WS closed after handset hangup`);

    handset.conn.close();
    console.log(
      `[e2e] OK — dial-pad → Twilio REST → TwiML callback → media WS → handset audio both ways → hangup all roundtripped`,
    );
  } finally {
    await api.kill();
    await twilio.stop();
  }
}

await main();
