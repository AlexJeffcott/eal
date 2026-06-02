import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { computeTwilioSignature } from '../twilio/signature.ts';
import { twilioHttpRoutes } from './family-phone-twilio.http.ts';
import type { PstnInboundRateLimiter } from './family-phone-pstn-rate-limit.ts';
import { createPstnCallOutcomes } from './family-phone-pstn-outcomes.ts';
import type { IvrDeps } from './family-phone-pstn-ivr.ts';
import { createDb } from '../db/client.ts';
import { applySchema } from '../db/schema.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createFamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';
import { createPstnContactsRepo } from '../db/repos/family-phone-pstn-contacts.ts';
import { createFamilyPhoneVoiceMessagesRepo } from '../db/repos/family-phone-voice-messages.ts';

const TWILIO = {
  accountSid: 'AC0123456789abcdef0123456789abcdef',
  authToken: 'test-auth-token',
  phoneNumber: '+441234567890',
  webhookSigningKey: 'unused-in-this-test',
};

const PUBLIC_HOST = 'eal.example.com';

function mountApp() {
  return new Elysia().use(twilioHttpRoutes({ twilio: TWILIO, publicHost: PUBLIC_HOST }));
}

type App = ReturnType<typeof mountApp>;

function urlencode(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  return params.toString();
}

async function postForm(
  app: App,
  path: string,
  fields: Record<string, string>,
  signatureHeader: string | null,
): Promise<{ status: number; headers: Headers; body: string }> {
  const url = `https://${PUBLIC_HOST}${path}`;
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (signatureHeader !== null) headers['x-twilio-signature'] = signatureHeader;
  const res = await app.handle(
    new Request(url, { method: 'POST', headers, body: urlencode(fields) }),
  );
  return { status: res.status, headers: res.headers, body: await res.text() };
}

const VALID_FIELDS = {
  CallSid: 'CA00000000000000000000000000000001',
  From: '+12025550100',
  To: TWILIO.phoneNumber,
  AccountSid: TWILIO.accountSid,
};

function signFor(fields: Record<string, string>, path = '/api/family-phone/twilio/voice'): string {
  return computeTwilioSignature(TWILIO.authToken, `https://${PUBLIC_HOST}${path}`, fields);
}

describe('POST /api/family-phone/twilio/voice', () => {
  test('rejects a request with no signature header (403)', async () => {
    const res = await postForm(mountApp(), '/api/family-phone/twilio/voice', VALID_FIELDS, null);
    expect(res.status).toBe(403);
    expect(res.body).toBe('forbidden');
  });

  test('rejects a tampered request (403)', async () => {
    const tampered = { ...VALID_FIELDS, From: '+9999999999' };
    const sigForOriginal = signFor(VALID_FIELDS);
    const res = await postForm(mountApp(), '/api/family-phone/twilio/voice', tampered, sigForOriginal);
    expect(res.status).toBe(403);
  });

  test('rejects a well-signed but underspecified payload (400)', async () => {
    const partial = { CallSid: 'CA1' };
    const sig = signFor(partial);
    const res = await postForm(mountApp(), '/api/family-phone/twilio/voice', partial, sig);
    expect(res.status).toBe(400);
    expect(res.body).toContain('missing required');
  });

  test('returns TwiML pointing at the wss:// media endpoint on a valid signed request', async () => {
    const sig = signFor(VALID_FIELDS);
    const res = await postForm(mountApp(), '/api/family-phone/twilio/voice', VALID_FIELDS, sig);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    expect(res.body).toContain('<?xml version="1.0"');
    expect(res.body).toContain('<Response>');
    expect(res.body).toContain(`wss://${PUBLIC_HOST}/api/family-phone/twilio/media`);
    expect(res.body).toContain(`value="${VALID_FIELDS.CallSid}"`);
    expect(res.body).toContain(`value="${VALID_FIELDS.From}"`);
    expect(res.body).toContain(`value="${VALID_FIELDS.To}"`);
  });

  test('inbound TwiML carries direction=inbound and no handset parameter', async () => {
    const sig = signFor(VALID_FIELDS);
    const res = await postForm(mountApp(), '/api/family-phone/twilio/voice', VALID_FIELDS, sig);
    expect(res.body).toContain('name="direction" value="inbound"');
    expect(res.body).not.toContain('name="handset"');
  });

  test('outbound query string lands in TwiML as direction + handset parameters', async () => {
    const path = '/api/family-phone/twilio/voice?direction=outbound&handset=42';
    const sig = signFor(VALID_FIELDS, path);
    const res = await postForm(mountApp(), path, VALID_FIELDS, sig);
    expect(res.status).toBe(200);
    expect(res.body).toContain('name="direction" value="outbound"');
    expect(res.body).toContain('name="handset" value="42"');
  });

  test('non-integer handset query param is dropped (no parameter emitted)', async () => {
    const path = '/api/family-phone/twilio/voice?direction=outbound&handset=banana';
    const sig = signFor(VALID_FIELDS, path);
    const res = await postForm(mountApp(), path, VALID_FIELDS, sig);
    expect(res.status).toBe(200);
    expect(res.body).toContain('name="direction" value="outbound"');
    expect(res.body).not.toContain('name="handset"');
  });

  test('escapes XML-unsafe characters in caller-id values', async () => {
    const fields = { ...VALID_FIELDS, From: '"<bobby>&apos;' };
    const sig = signFor(fields);
    const res = await postForm(mountApp(), '/api/family-phone/twilio/voice', fields, sig);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('<bobby>');
    expect(res.body).toContain('&lt;bobby&gt;');
    expect(res.body).toContain('&quot;');
  });
});

describe('POST /api/family-phone/twilio/voice — Phase 7D rate limit', () => {
  function makeRateLimit(verdicts: Array<{ allowed: boolean; count: number }>): {
    limiter: PstnInboundRateLimiter;
    seen: string[];
  } {
    const seen: string[] = [];
    let i = 0;
    return {
      seen,
      limiter: {
        check(source): { allowed: boolean; count: number; windowMs: number; max: number } {
          seen.push(source);
          const v = verdicts[Math.min(i, verdicts.length - 1)] ?? { allowed: true, count: 1 };
          i++;
          return { ...v, windowMs: 60_000, max: 10 };
        },
      },
    };
  }

  test('over-limit inbound returns TwiML <Reject> and does not open the stream', async () => {
    const { limiter, seen } = makeRateLimit([{ allowed: false, count: 11 }]);
    const app = new Elysia().use(
      twilioHttpRoutes({ twilio: TWILIO, publicHost: PUBLIC_HOST, rateLimit: limiter }),
    );
    const sig = signFor(VALID_FIELDS);
    const res = await postForm(app, '/api/family-phone/twilio/voice', VALID_FIELDS, sig);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<Reject reason="busy"/>');
    expect(res.body).not.toContain('<Stream');
    expect(seen).toEqual([VALID_FIELDS.From]);
  });

  test('under-limit inbound passes through to the usual <Stream> TwiML', async () => {
    const { limiter } = makeRateLimit([{ allowed: true, count: 1 }]);
    const app = new Elysia().use(
      twilioHttpRoutes({ twilio: TWILIO, publicHost: PUBLIC_HOST, rateLimit: limiter }),
    );
    const sig = signFor(VALID_FIELDS);
    const res = await postForm(app, '/api/family-phone/twilio/voice', VALID_FIELDS, sig);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<Stream');
    expect(res.body).not.toContain('<Reject');
  });

  test('an unsigned request does not consume rate-limit budget', async () => {
    const { limiter, seen } = makeRateLimit([{ allowed: true, count: 1 }]);
    const app = new Elysia().use(
      twilioHttpRoutes({ twilio: TWILIO, publicHost: PUBLIC_HOST, rateLimit: limiter }),
    );
    const res = await postForm(app, '/api/family-phone/twilio/voice', VALID_FIELDS, null);
    expect(res.status).toBe(403);
    // Signature check fails before the limiter is consulted; otherwise
    // an attacker could pre-flight a forged request to push a real
    // caller over the limit without ever proving auth.
    expect(seen).toEqual([]);
  });

  test('a tampered body does not consume rate-limit budget either', async () => {
    const { limiter, seen } = makeRateLimit([{ allowed: true, count: 1 }]);
    const app = new Elysia().use(
      twilioHttpRoutes({ twilio: TWILIO, publicHost: PUBLIC_HOST, rateLimit: limiter }),
    );
    const sig = signFor({ From: '+1' });
    const res = await postForm(app, '/api/family-phone/twilio/voice', VALID_FIELDS, sig);
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
  });

  test('outbound TwiML callbacks skip the rate limiter — From is our own trunk number', async () => {
    const { limiter, seen } = makeRateLimit([{ allowed: false, count: 99 }]);
    const app = new Elysia().use(
      twilioHttpRoutes({ twilio: TWILIO, publicHost: PUBLIC_HOST, rateLimit: limiter }),
    );
    const outboundPath = '/api/family-phone/twilio/voice?direction=outbound&handset=1';
    const sig = signFor(VALID_FIELDS, outboundPath);
    const res = await postForm(app, outboundPath, VALID_FIELDS, sig);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<Stream');
    expect(seen).toEqual([]);
  });
});

describe('IVR + voicemail routes (Phase 7D)', () => {
  function buildIvrApp() {
    const db = createDb(':memory:');
    applySchema(db);
    const users = createUsersRepo(db);
    const alex = users.insert({ displayName: 'alex' });
    const sarah = users.insert({ displayName: 'sarah' });
    users.setInIvrMenu(alex.id, true);
    users.setInIvrMenu(sarah.id, true);
    const devices = createFamilyPhoneDevicesRepo(db);
    const alexPhone = devices.insert({ userId: alex.id, label: 'phone', kind: 'handset' });
    const pstnContacts = createPstnContactsRepo(db);
    const voicemails = createFamilyPhoneVoiceMessagesRepo(db);
    const outcomes = createPstnCallOutcomes();
    const ivr: IvrDeps = {
      twilio: TWILIO,
      users,
      pstnContacts,
      devices,
      voicemails,
      outcomes,
      publicHost: PUBLIC_HOST,
    };
    const app = new Elysia().use(twilioHttpRoutes({ twilio: TWILIO, publicHost: PUBLIC_HOST, ivr }));
    return { app, ivr, db, alex, sarah, alexPhone };
  }

  test('inbound from a known contact with intended recipient emits Connect with routed_user_id', () => {
    const { app, ivr, alex } = buildIvrApp();
    ivr.pstnContacts.insert({
      e164: '+12025550100',
      label: 'Nonna',
      allowIn: true,
      allowOut: true,
      intendedUserId: alex.id,
    });
    const sig = signFor(VALID_FIELDS);
    return postForm(app, '/api/family-phone/twilio/voice', VALID_FIELDS, sig).then((res) => {
      expect(res.status).toBe(200);
      expect(res.body).toContain('<Connect');
      expect(res.body).toContain(`name="routed_user_id" value="${alex.id}"`);
    });
  });

  test('inbound from an unknown caller returns the DTMF Gather menu', () => {
    const { app } = buildIvrApp();
    const sig = signFor(VALID_FIELDS);
    return postForm(app, '/api/family-phone/twilio/voice', VALID_FIELDS, sig).then((res) => {
      expect(res.status).toBe(200);
      expect(res.body).toContain('<Gather');
      expect(res.body).toContain('Press 1 for alex');
      expect(res.body).toContain('Press 2 for sarah');
    });
  });

  test('/ivr-pick with digit "1" emits Connect routed to the first menu user and primes outcomes', async () => {
    const { app, ivr, alex } = buildIvrApp();
    const path = '/api/family-phone/twilio/ivr-pick';
    const fields = { ...VALID_FIELDS, Digits: '1' };
    const sig = signFor(fields, path);
    const res = await postForm(app, path, fields, sig);
    expect(res.status).toBe(200);
    expect(res.body).toContain(`name="routed_user_id" value="${alex.id}"`);
    const primed = ivr.outcomes.get(VALID_FIELDS.CallSid);
    expect(primed?.voicemailTarget.kind).toBe('user');
  });

  test('/ivr-pick with no Digits drops to household Record and primes outcomes for household', async () => {
    const { app, ivr } = buildIvrApp();
    const path = '/api/family-phone/twilio/ivr-pick';
    const fields = { ...VALID_FIELDS, Digits: '' };
    const sig = signFor(fields, path);
    const res = await postForm(app, path, fields, sig);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<Record');
    const primed = ivr.outcomes.get(VALID_FIELDS.CallSid);
    expect(primed?.voicemailTarget.kind).toBe('household');
  });

  test('/ivr-pick with unsigned request is 403', async () => {
    const { app } = buildIvrApp();
    const res = await postForm(app, '/api/family-phone/twilio/ivr-pick', VALID_FIELDS, null);
    expect(res.status).toBe(403);
  });

  test('/after-connect returns empty Response when the call was answered', async () => {
    const { app, ivr } = buildIvrApp();
    ivr.outcomes.prime(
      VALID_FIELDS.CallSid,
      { kind: 'household', householdDeviceId: 1 },
      VALID_FIELDS.From,
    );
    ivr.outcomes.setOutcome(VALID_FIELDS.CallSid, 'answered');
    const path = '/api/family-phone/twilio/after-connect';
    const sig = signFor(VALID_FIELDS, path);
    const res = await postForm(app, path, VALID_FIELDS, sig);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<Response/>');
    expect(res.body).not.toContain('<Record');
  });

  test('/after-connect returns Record when the call was unanswered', async () => {
    const { app, ivr } = buildIvrApp();
    ivr.outcomes.prime(
      VALID_FIELDS.CallSid,
      { kind: 'household', householdDeviceId: 1 },
      VALID_FIELDS.From,
    );
    // Outcome stays the primed default ('unanswered').
    const path = '/api/family-phone/twilio/after-connect';
    const sig = signFor(VALID_FIELDS, path);
    const res = await postForm(app, path, VALID_FIELDS, sig);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<Record');
  });

  test('/recording fetches the WAV from Twilio and writes one voicemail row per recipient device', async () => {
    const { app, ivr, alex, alexPhone } = buildIvrApp();
    ivr.outcomes.prime(
      VALID_FIELDS.CallSid,
      { kind: 'user', userId: alex.id, deviceIds: [alexPhone.id] },
      VALID_FIELDS.From,
    );
    // Synthesise a minimal 1-second 8 kHz mono WAV (8000 samples × 2 bytes).
    const pcm = new Uint8Array(16_000);
    const fmtSize = 16;
    const dataSize = pcm.byteLength;
    const totalRiffSize = 4 + (8 + fmtSize) + (8 + dataSize);
    const wav = new Uint8Array(8 + totalRiffSize);
    const view = new DataView(wav.buffer);
    const enc = new TextEncoder();
    wav.set(enc.encode('RIFF'), 0);
    view.setUint32(4, totalRiffSize, true);
    wav.set(enc.encode('WAVE'), 8);
    wav.set(enc.encode('fmt '), 12);
    view.setUint32(16, fmtSize, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    wav.set(enc.encode('data'), 36);
    view.setUint32(40, dataSize, true);
    wav.set(pcm, 44);
    const twilioFetched: Array<{ url: string; auth: string }> = [];
    const fakeFetch: typeof fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        let url: string;
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.toString();
        else url = input.url;
        const headers = new Headers(init?.headers);
        twilioFetched.push({ url, auth: headers.get('authorization') ?? '' });
        return Promise.resolve(
          new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } }),
        );
      },
      { preconnect: () => undefined },
    );
    ivr.fetch = fakeFetch;
    const recPath = '/api/family-phone/twilio/recording?target=primed';
    const recFields = {
      CallSid: VALID_FIELDS.CallSid,
      From: VALID_FIELDS.From,
      RecordingUrl: 'https://api.twilio.com/recordings/RE1',
      RecordingDuration: '1',
    };
    const sig = signFor(recFields, recPath);
    const res = await postForm(app, recPath, recFields, sig);
    expect(res.status).toBe(200);
    expect(twilioFetched).toHaveLength(1);
    expect(twilioFetched[0]?.url).toBe('https://api.twilio.com/recordings/RE1.wav');
    expect(twilioFetched[0]?.auth.startsWith('Basic ')).toBe(true);
    const rows = ivr.voicemails.list({ toDeviceId: alexPhone.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from_external).toBe(VALID_FIELDS.From);
    expect(rows[0]?.duration_ms).toBe(1000);
    // Outcomes record is dropped post-persist.
    expect(ivr.outcomes.get(VALID_FIELDS.CallSid)).toBeNull();
  });
});
