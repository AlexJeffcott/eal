import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { computeTwilioSignature } from '../twilio/signature.ts';
import { twilioHttpRoutes } from './family-phone-twilio.http.ts';
import type { PstnInboundRateLimiter } from './family-phone-pstn-rate-limit.ts';

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
