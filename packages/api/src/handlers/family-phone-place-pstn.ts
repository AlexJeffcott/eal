import type { TwilioRestClient } from '../twilio/rest.ts';
import { TwilioRestError } from '../twilio/rest.ts';
import type { FamilyPhoneDevicesRepo } from '../db/repos/family-phone-devices.ts';

/**
 * Phase 7C.3 — server-side glue behind a handset's "dial out" tap.
 * The WS handler intercepts the `call:place-pstn` envelope and calls
 * `placePstn`, which:
 *
 *   1. Validates the dialed number's E.164 shape.
 *   2. Materialises the PSTN counterparty as a kind='pstn' device row,
 *      so the eventual media-WS bridge has the row id to register a
 *      virtual device against.
 *   3. Asks Twilio to dial out via the REST client, threading the
 *      handset's device id into the TwiML URL query string. Twilio
 *      signs that URL back to us when it fetches the TwiML; the
 *      voice-webhook verifier proves the params landed unchanged.
 *   4. Returns the CallSid (the handset's UI shows "Calling…" until
 *      the bridge fires `call:incoming` from the PSTN device).
 *
 * Pure module — no DB transactions outside the devices repo, no env
 * reads. The WS handler injects the dependencies it has from its
 * routes-time bootstrap.
 *
 * Allowlist note: 7D adds a per-source-number allowlist via
 * `family_phone_pstn_contacts.allow_out`. This module accepts an
 * `isOutboundAllowed` callback so 7D can plug that gate in without
 * the WS handler having to know about the contacts table.
 */
export type PlacePstnResult =
  | { ok: true; callSid: string }
  | { ok: false; reason: PlacePstnFailureReason };

export type PlacePstnFailureReason =
  | 'bad-e164'
  | 'not-allowed'
  | 'twilio-rejected'
  | 'twilio-unreachable';

export interface PlacePstnInput {
  fromDeviceId: number;
  to: string;
}

export interface PlacePstnDeps {
  restClient: TwilioRestClient;
  devices: FamilyPhoneDevicesRepo;
  /**
   * Public origin Twilio fetches the TwiML response from. The URL the
   * client constructs is `${twimlBaseUrl}?direction=outbound&handset=<id>`.
   * Matches `EAL_ORIGIN` in production; tests pass a placeholder.
   */
  twimlBaseUrl: string;
  /**
   * Optional per-E.164 outbound allowlist. Returns true to allow the
   * call, false to reject with reason='not-allowed'. When omitted,
   * every well-formed E.164 is allowed (the 7C pre-7D default).
   */
  isOutboundAllowed?: (toE164: string) => boolean;
}

/**
 * Twilio's E.164 contract: `+` followed by a country-code-digit
 * (1–9) and 6–14 more digits. Same regex as `twilio/config.ts`'s
 * trunk-number validator — they share the same shape constraint.
 */
const E164 = /^\+[1-9]\d{6,14}$/;

export async function placePstn(
  deps: PlacePstnDeps,
  input: PlacePstnInput,
): Promise<PlacePstnResult> {
  if (!E164.test(input.to)) {
    return { ok: false, reason: 'bad-e164' };
  }
  if (deps.isOutboundAllowed && !deps.isOutboundAllowed(input.to)) {
    return { ok: false, reason: 'not-allowed' };
  }
  // Upsert the PSTN device row before we hand control to Twilio so
  // the row exists by the time the inbound media WS arrives. The
  // bridge will look it up by E.164 again from its side — idempotent.
  deps.devices.upsertPstnByE164(input.to);
  const twimlUrl = buildTwimlUrl(deps.twimlBaseUrl, input.fromDeviceId);
  try {
    const { callSid } = await deps.restClient.placeOutboundCall({
      to: input.to,
      twimlUrl,
    });
    return { ok: true, callSid };
  } catch (err) {
    if (err instanceof TwilioRestError) {
      // 4xx → Twilio rejected the request (bad number, blocked, etc.);
      // 5xx / network → transport problem. The handset's UI shows
      // distinct messages so a retry is meaningful in one case and
      // not in the other.
      const transport = err.httpStatus >= 500 || err.httpStatus === 0;
      return { ok: false, reason: transport ? 'twilio-unreachable' : 'twilio-rejected' };
    }
    // Non-TwilioRestError: a non-HTTP failure from the fetch transport
    // itself (DNS, TLS, abort). Treat as unreachable.
    return { ok: false, reason: 'twilio-unreachable' };
  }
}

function buildTwimlUrl(base: string, handsetId: number): string {
  // `base` is the configured voice-webhook origin + path. Use URL so
  // a base that already carries a query string (unusual but possible
  // in tests) merges correctly.
  const url = new URL(base);
  url.searchParams.set('direction', 'outbound');
  url.searchParams.set('handset', String(handsetId));
  return url.toString();
}
