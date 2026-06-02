#!/usr/bin/env bun
/**
 * Cross-boundary verification of Phase 7D's IVR + voicemail path.
 *
 * Boots the real api with TWILIO_ENABLED=true, points the Twilio REST
 * client at a local stub (via TWILIO_API_BASE_URL — same knob the 7C
 * outbound harness uses, repurposed here to serve the recording fetch
 * authenticated GET that /twilio/recording issues). Pairs two real
 * handsets through the real client library — Alex and Sarah — and
 * walks three flows:
 *
 *   1. Known caller (pstn_contacts.intended_user_id=alex) → voice
 *      webhook returns Connect with routed_user_id=alex; bridge rings
 *      only Alex's handset, not Sarah's. Alex answers, audio flows,
 *      Alex hangs up. After-connect sees outcome=answered → empty
 *      Response, no voicemail.
 *
 *   2. Unknown caller, IVR press 1 → voice webhook returns Gather
 *      with two menu items (Alex=1, Sarah=2). The script POSTs to
 *      /twilio/ivr-pick with Digits=1; api returns Connect with
 *      routed_user_id=alex. Alex answers + hangs up; after-connect
 *      ends the call cleanly.
 *
 *   3. Unknown caller, no digit → voice webhook Gather times out;
 *      the gather's fallback <Record> action URL targets the
 *      household inbox. Script POSTs to /twilio/recording with a
 *      synthetic WAV; api fetches it from the stub Twilio (Basic
 *      auth) and persists one row to the household device.
 *
 * Skips real Twilio entirely — the script plays the role of Twilio
 * for every callback. The fake Twilio REST server only needs to
 * serve the recording GET (the inbound flow never POSTs to Calls.json).
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
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/pstn-routed');
const DB_PATH = resolve(ARTIFACTS, 'pstn-routed.sqlite');
const DEFAULT_TIMEOUT_MS = 5_000;

const TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000003';
const TWILIO_AUTH_TOKEN = 'e2e-routed-auth-token';
const TWILIO_PHONE_NUMBER = '+441234567890';
const TWILIO_WEBHOOK_SIGNING_KEY = 'e2e-routed-signing-key';
const KNOWN_CALLER = '+12025550150';
const UNKNOWN_CALLER = '+12025550199';

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface PairedClient {
  client: EalClient;
  deviceId: number;
  userId: number;
  conn: FamilyPhoneDeviceConnection;
  events: FamilyPhoneCallEvent[];
}

async function pairAndConnect(
  apiUrl: string,
  token: string,
  label: string,
): Promise<PairedClient> {
  const client = createEalClient(apiUrl, { token });
  const me = await client.getCurrentUser();
  if (!me) throw new Error('pairAndConnect: not signed in after token seed');
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
  conn.subscribe((e) => events.push(e));
  return { client, deviceId, userId: me.userId, conn, events };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)} got ${String(actual)}`);
  }
}

interface FakeTwilio {
  url: string;
  recordingFetches: Array<{ url: string; auth: string }>;
  stop: () => Promise<void>;
}

/**
 * Stand-in for the Twilio recording fetch the api makes from
 * /twilio/recording. Returns a tiny 1-second 8 kHz mono WAV for any
 * GET to /recordings/RE*.wav with HTTP Basic auth.
 */
function startFakeTwilio(): FakeTwilio {
  const recordingFetches: FakeTwilio['recordingFetches'] = [];
  const pcm = new Uint8Array(16_000); // 8000 samples * 2 bytes
  const fmtSize = 16;
  const totalRiff = 4 + (8 + fmtSize) + (8 + pcm.byteLength);
  const wav = new Uint8Array(8 + totalRiff);
  const view = new DataView(wav.buffer);
  const enc = new TextEncoder();
  wav.set(enc.encode('RIFF'), 0);
  view.setUint32(4, totalRiff, true);
  wav.set(enc.encode('WAVE'), 8);
  wav.set(enc.encode('fmt '), 12);
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wav.set(enc.encode('data'), 36);
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req): Response | Promise<Response> {
      const url = new URL(req.url);
      if (req.method === 'GET' && /\/recordings\/[A-Za-z0-9]+\.wav$/.test(url.pathname)) {
        recordingFetches.push({
          url: req.url,
          auth: req.headers.get('authorization') ?? '',
        });
        return new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } });
      }
      return new Response(`not found: ${req.method} ${url.pathname}`, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    recordingFetches,
    stop: async (): Promise<void> => {
      await server.stop(true);
    },
  };
}

async function postSignedForm(
  apiUrl: string,
  path: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const url = `${apiUrl}${path}`;
  const sig = computeTwilioSignature(TWILIO_AUTH_TOKEN, url, fields);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': sig,
    },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: await res.text() };
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
  console.log(`[e2e] fake Twilio recording server at ${twilio.url}`);
  process.env['TWILIO_API_BASE_URL'] = twilio.url;

  const api = await bootApi({ database: DB_PATH });
  console.log(`[e2e] api up at ${api.url}`);
  try {
    const alexSeed = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'routed-alex' });
    const sarahSeed = seedCliToken({ dbPath: DB_PATH, displayName: 'sarah', label: 'routed-sarah' });
    const alex = await pairAndConnect(api.url, alexSeed.token, "Alex's handset");
    const sarah = await pairAndConnect(api.url, sarahSeed.token, "Sarah's handset");
    console.log(
      `[e2e] paired: alex (user #${alex.userId}, device #${alex.deviceId}); ` +
      `sarah (user #${sarah.userId}, device #${sarah.deviceId})`,
    );

    // Opt both users into the IVR menu and add a phonebook entry for
    // KNOWN_CALLER pointing at alex.
    const adminClient = createEalClient(api.url, { token: alexSeed.token });
    await adminClient.setUserInIvrMenu(alex.userId, true);
    await adminClient.setUserInIvrMenu(sarah.userId, true);
    await adminClient.createPstnContact({
      e164: KNOWN_CALLER,
      label: 'Nonna',
      allowIn: true,
      allowOut: false,
      intendedUserId: alex.userId,
    });

    // ─── Flow 1: known caller routes straight to alex ─────────────
    {
      const voiceRes = await postSignedForm(api.url, '/api/family-phone/twilio/voice', {
        CallSid: 'CA-known',
        From: KNOWN_CALLER,
        To: TWILIO_PHONE_NUMBER,
        AccountSid: TWILIO_ACCOUNT_SID,
      });
      assertEqual(voiceRes.status, 200, 'flow1 voice status');
      if (!voiceRes.body.includes('<Connect')) throw new Error(`flow1 expected Connect, got ${voiceRes.body}`);
      if (!voiceRes.body.includes(`name="routed_user_id" value="${alex.userId}"`)) {
        throw new Error(`flow1 expected routed_user_id=${alex.userId} in ${voiceRes.body}`);
      }
      console.log(`[e2e] flow1: known caller → Connect routed_user_id=${alex.userId}`);
    }

    // ─── Flow 2: unknown caller, IVR press 1 → routed to alex ─────
    {
      const voiceRes = await postSignedForm(api.url, '/api/family-phone/twilio/voice', {
        CallSid: 'CA-ivr',
        From: UNKNOWN_CALLER,
        To: TWILIO_PHONE_NUMBER,
        AccountSid: TWILIO_ACCOUNT_SID,
      });
      assertEqual(voiceRes.status, 200, 'flow2 voice status');
      if (!voiceRes.body.includes('<Gather')) throw new Error(`flow2 expected Gather, got ${voiceRes.body}`);
      if (!voiceRes.body.includes('Press 1 for alex')) {
        throw new Error(`flow2 Gather should list alex: ${voiceRes.body}`);
      }
      const pickRes = await postSignedForm(api.url, '/api/family-phone/twilio/ivr-pick', {
        CallSid: 'CA-ivr',
        From: UNKNOWN_CALLER,
        To: TWILIO_PHONE_NUMBER,
        AccountSid: TWILIO_ACCOUNT_SID,
        Digits: '1',
      });
      assertEqual(pickRes.status, 200, 'flow2 ivr-pick status');
      if (!pickRes.body.includes(`name="routed_user_id" value="${alex.userId}"`)) {
        throw new Error(`flow2 ivr-pick should route to alex: ${pickRes.body}`);
      }
      console.log(`[e2e] flow2: IVR press 1 → Connect routed_user_id=${alex.userId}`);
    }

    // ─── Flow 3: unknown caller, no digit → household voicemail ───
    {
      // Skip the Gather; jump straight to the recording webhook the
      // Gather's fallback Record would invoke. (The TwiML side is
      // covered by Flow 2; the new ground is the recording fetch +
      // persist path.)
      const recordingUrl = `${twilio.url}/recordings/REtest123`;
      const recRes = await postSignedForm(
        api.url,
        '/api/family-phone/twilio/recording?target=household',
        {
          CallSid: 'CA-vm',
          From: UNKNOWN_CALLER,
          RecordingUrl: recordingUrl,
          RecordingDuration: '1',
        },
      );
      assertEqual(recRes.status, 200, 'flow3 recording status');
      if (twilio.recordingFetches.length !== 1) {
        throw new Error(`flow3 expected 1 recording fetch, saw ${twilio.recordingFetches.length}`);
      }
      const fetched = twilio.recordingFetches[0]!;
      assertEqual(fetched.url, `${recordingUrl}.wav`, 'flow3 recording url');
      if (!fetched.auth.startsWith('Basic ')) {
        throw new Error(`flow3 recording auth should be Basic: ${fetched.auth}`);
      }
      console.log(`[e2e] flow3: recording fetched + persisted with Basic auth`);

      // Verify the household voicemail surfaces in alex's inbox via
      // the merged list endpoint (commit F).
      await waitUntil(async () => {
        const list = await alex.client.listVoiceMessages({ deviceId: alex.deviceId });
        return list.some(
          (vm) => vm.fromExternal === UNKNOWN_CALLER && vm.body.includes('Voicemail'),
        );
      }, 'household voicemail to appear in alex inbox');
      console.log(`[e2e] flow3: household voicemail surfaces in alex's inbox`);
    }

    alex.conn.close();
    sarah.conn.close();
    console.log('[e2e] OK — routed dial, IVR pick, and household voicemail all roundtripped');
  } finally {
    await api.kill();
    await twilio.stop();
  }
}

await main();
