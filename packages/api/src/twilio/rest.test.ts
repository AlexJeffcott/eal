import { describe, expect, test } from 'bun:test';
import { createTwilioRestClient, TwilioRestError } from './rest.ts';
import type { TwilioConfig } from './config.ts';

const CONFIG: TwilioConfig = {
  accountSid: 'AC00000000000000000000000000000001',
  authToken: 'auth-token-secret',
  phoneNumber: '+441234567890',
  webhookSigningKey: 'unused-here',
};

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function makeFetch(
  respond: (req: CapturedRequest) => { status: number; body: string },
): { fetch: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    const req: CapturedRequest = { url, method: init?.method ?? 'GET', headers, body };
    captured.push(req);
    const r = respond(req);
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fakeFetch, captured };
}

describe('createTwilioRestClient.placeOutboundCall', () => {
  test('posts to /Accounts/{SID}/Calls.json with the required form fields', async () => {
    const { fetch, captured } = makeFetch(() => ({
      status: 201,
      body: JSON.stringify({ sid: 'CA00000000000000000000000000000001', status: 'queued' }),
    }));
    const client = createTwilioRestClient({ config: CONFIG, fetch });
    await client.placeOutboundCall({
      to: '+12025550100',
      twimlUrl: 'https://eal.example.com/api/family-phone/twilio/voice?direction=outbound',
    });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.accountSid}/Calls.json`,
    );
    expect(req.method).toBe('POST');
    expect(req.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(req.body);
    expect(form.get('From')).toBe(CONFIG.phoneNumber);
    expect(form.get('To')).toBe('+12025550100');
    expect(form.get('Url')).toBe(
      'https://eal.example.com/api/family-phone/twilio/voice?direction=outbound',
    );
  });

  test('sends HTTP Basic auth as base64(accountSid:authToken)', async () => {
    const { fetch, captured } = makeFetch(() => ({
      status: 201,
      body: JSON.stringify({ sid: 'CA1', status: 'queued' }),
    }));
    const client = createTwilioRestClient({ config: CONFIG, fetch });
    await client.placeOutboundCall({ to: '+12025550100', twimlUrl: 'https://x/y' });

    const expected = `Basic ${btoa(`${CONFIG.accountSid}:${CONFIG.authToken}`)}`;
    expect(captured[0]?.headers.get('authorization')).toBe(expected);
  });

  test('returns the parsed CallSid and status from a 201 response', async () => {
    const { fetch } = makeFetch(() => ({
      status: 201,
      body: JSON.stringify({ sid: 'CAabc', status: 'queued', account_sid: CONFIG.accountSid }),
    }));
    const client = createTwilioRestClient({ config: CONFIG, fetch });
    const result = await client.placeOutboundCall({ to: '+12025550100', twimlUrl: 'https://x/y' });
    expect(result).toEqual({ callSid: 'CAabc', status: 'queued' });
  });

  test('throws TwilioRestError with code + message on a 4xx body', async () => {
    const { fetch } = makeFetch(() => ({
      status: 400,
      body: JSON.stringify({
        code: 21217,
        message: "Phone number '12025550100' is not formatted correctly. (E.164)",
        status: 400,
      }),
    }));
    const client = createTwilioRestClient({ config: CONFIG, fetch });
    let caught: unknown = null;
    try {
      await client.placeOutboundCall({ to: '12025550100', twimlUrl: 'https://x/y' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TwilioRestError);
    if (!(caught instanceof TwilioRestError)) throw new Error('unreachable');
    expect(caught.httpStatus).toBe(400);
    expect(caught.code).toBe(21217);
    expect(caught.message).toContain('E.164');
  });

  test('throws TwilioRestError on a 5xx with a non-JSON body', async () => {
    const { fetch } = makeFetch(() => ({ status: 503, body: '<html>down</html>' }));
    const client = createTwilioRestClient({ config: CONFIG, fetch });
    let caught: unknown = null;
    try {
      await client.placeOutboundCall({ to: '+12025550100', twimlUrl: 'https://x/y' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TwilioRestError);
    if (!(caught instanceof TwilioRestError)) throw new Error('unreachable');
    expect(caught.httpStatus).toBe(503);
    expect(caught.code).toBeUndefined();
    expect(caught.message).toContain('<html>down</html>');
  });

  test('throws if a 2xx body omits sid or status (Twilio contract violation)', async () => {
    const { fetch } = makeFetch(() => ({
      status: 201,
      body: JSON.stringify({ account_sid: CONFIG.accountSid }),
    }));
    const client = createTwilioRestClient({ config: CONFIG, fetch });
    let caught: unknown = null;
    try {
      await client.placeOutboundCall({ to: '+12025550100', twimlUrl: 'https://x/y' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TwilioRestError);
  });
});
