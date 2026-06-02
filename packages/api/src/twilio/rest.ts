/**
 * Phase 7C.1 — Twilio REST client. The household uses exactly one API:
 * POST `/2010-04-01/Accounts/{SID}/Calls.json` to dial an outbound
 * call. Twilio then fetches the supplied TwiML URL (the same handler
 * the inbound webhook serves, gated on a query-string flag the bridge
 * uses to skip fan-out) and opens a Media Stream WS back at the api.
 *
 * Pure module — no DB, no env reads, no global fetch. The handler that
 * places a call constructs a client with the loaded `TwilioConfig` and
 * an optional `fetch` override (tests pass a captured fake; production
 * uses the global). Errors carry Twilio's structured fields so the
 * caller can distinguish "bad number" from "rate-limited" from
 * "transient 5xx".
 *
 * Docs: https://www.twilio.com/docs/voice/api/call-resource#create-a-call-resource
 */
import type { TwilioConfig } from './config.ts';

const DEFAULT_TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

export interface PlaceOutboundCallInput {
  /** The E.164 number the trunk should dial. */
  to: string;
  /**
   * Fully-qualified URL Twilio fetches once the call connects. The
   * response must be TwiML — for the household bridge this is a
   * `<Connect><Stream>` pointing at `/api/family-phone/twilio/media`.
   */
  twimlUrl: string;
}

export interface PlaceOutboundCallResult {
  /** Twilio's CallSid (`CA…`). The bridge uses it to correlate the
   * eventual Media Stream `start` frame back to the originating
   * request. */
  callSid: string;
  /** Status Twilio reports at create time — typically `queued`. */
  status: string;
}

/**
 * Thrown on every non-2xx response. `code` is Twilio's numeric error
 * code (e.g. 21217 "phone number is not E.164") when the body parses
 * as JSON; absent for transport or non-JSON failures. `message` is
 * always populated.
 */
export class TwilioRestError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'TwilioRestError';
  }
}

export interface TwilioRestClient {
  placeOutboundCall(input: PlaceOutboundCallInput): Promise<PlaceOutboundCallResult>;
}

export interface TwilioRestDeps {
  config: TwilioConfig;
  /**
   * Override the HTTP transport. Tests pass a captured fake; production
   * leaves it undefined and the global `fetch` is used. The override
   * lets the test gate URL, headers, and body without spinning up an
   * HTTPS interceptor.
   */
  fetch?: typeof fetch;
}

export function createTwilioRestClient(deps: TwilioRestDeps): TwilioRestClient {
  const httpFetch = deps.fetch ?? fetch;
  const { accountSid, authToken, phoneNumber, apiBaseUrl } = deps.config;
  const base = (apiBaseUrl ?? DEFAULT_TWILIO_API_BASE).replace(/\/+$/, '');
  const callsUrl = `${base}/Accounts/${accountSid}/Calls.json`;
  // HTTP Basic per Twilio's auth scheme: base64(SID:Token). Built once
  // — the credential is stable for the process lifetime.
  const basicAuth = `Basic ${btoa(`${accountSid}:${authToken}`)}`;

  return {
    async placeOutboundCall(input): Promise<PlaceOutboundCallResult> {
      const body = new URLSearchParams({
        From: phoneNumber,
        To: input.to,
        Url: input.twimlUrl,
      });
      const res = await httpFetch(callsUrl, {
        method: 'POST',
        headers: {
          authorization: basicAuth,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      });
      const rawBody = await res.text();
      const parsed = safeJsonParse(rawBody);
      if (res.status < 200 || res.status >= 300) {
        throw buildRestError(res.status, parsed, rawBody);
      }
      const sid = readString(parsed, 'sid');
      const status = readString(parsed, 'status');
      if (sid === null || status === null) {
        throw new TwilioRestError(
          `Twilio Calls.json returned ${res.status} but no sid/status in body: ${rawBody}`,
          res.status,
        );
      }
      return { callSid: sid, status };
    },
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function readString(record: unknown, key: string): string | null {
  if (typeof record !== 'object' || record === null) return null;
  const value = Reflect.get(record, key);
  return typeof value === 'string' ? value : null;
}

function readNumber(record: unknown, key: string): number | null {
  if (typeof record !== 'object' || record === null) return null;
  const value = Reflect.get(record, key);
  return typeof value === 'number' ? value : null;
}

function buildRestError(httpStatus: number, parsed: unknown, rawBody: string): TwilioRestError {
  const code = readNumber(parsed, 'code') ?? undefined;
  const message =
    readString(parsed, 'message') ?? `Twilio Calls.json failed (${httpStatus}): ${rawBody}`;
  return new TwilioRestError(message, httpStatus, code);
}
