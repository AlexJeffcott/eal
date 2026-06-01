import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { computeTwilioSignature } from '../twilio/signature.ts';
import { twilioHttpRoutes } from './family-phone-twilio.http.ts';

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
