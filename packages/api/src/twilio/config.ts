/**
 * Phase 7B — Twilio trunk environment configuration.
 *
 * The trunk is gated by `TWILIO_ENABLED`. When unset or "false", the
 * webhook + media handlers do not register, and the rest of the family-
 * phone stack runs unchanged. When "true", every other variable below
 * is required and verified on the way in — a missing key fails the boot
 * loudly per project policy (no silent fallbacks).
 */

export interface TwilioConfig {
  /** Twilio's REST API account SID (`AC…`). */
  accountSid: string;
  /** Auth token paired with the account; signs webhook callbacks. */
  authToken: string;
  /** The household's E.164 trunk number — the inbound DID, and the
   * default outbound caller ID. */
  phoneNumber: string;
  /**
   * Caller ID presented on outbound calls (the `From` field on Twilio's
   * Calls.json). Defaults to `phoneNumber` — standard Twilio behaviour,
   * and correct for most regions. It is split out because Italy's AGCOM
   * anti-spoofing filter (2025) blocks any internationally-routed call
   * that presents an Italian CLI: a Twilio-originated call into Italy
   * carrying an Italian trunk number as caller ID is dropped, with no
   * whitelist workaround. Where the DID is Italian, set `TWILIO_CALLER_ID`
   * to a non-Italian number so outbound calls ring (the recipient sees a
   * foreign number) while inbound keeps the Italian `phoneNumber` DID.
   * See docs/family-phone.md Phase 7.
   */
  callerId: string;
  /**
   * Override for the Twilio REST API base URL. Production omits this
   * and the REST client uses Twilio's real endpoint. The
   * `scripts/e2e-pstn-outbound.ts` harness sets `TWILIO_API_BASE_URL`
   * to point at a local stub so the outbound path can be exercised
   * without hitting Twilio for real. Undefined means "use the live
   * endpoint" — explicit, not a silent fallback.
   */
  apiBaseUrl?: string;
}

/** E.164: `+`, a country-code digit (1–9), then 6–14 more digits. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Build the trunk config from the process environment. Returns `null`
 * when the trunk is disabled (the family-phone stack still boots; the
 * Twilio handlers simply do not mount). Throws when enabled but any
 * required variable is missing — boot must not silently proceed in a
 * half-configured state.
 */
export function loadTwilioConfig(env: NodeJS.ProcessEnv = process.env): TwilioConfig | null {
  const enabled = env['TWILIO_ENABLED'];
  if (enabled === undefined || enabled === '' || enabled === 'false') return null;
  if (enabled !== 'true') {
    throw new Error(
      `EAL_API: TWILIO_ENABLED="${enabled}" — expected "true" or "false" (or unset).`,
    );
  }
  const accountSid = env['TWILIO_ACCOUNT_SID'];
  const authToken = env['TWILIO_AUTH_TOKEN'];
  const phoneNumber = env['TWILIO_PHONE_NUMBER'];
  const missing: string[] = [];
  if (accountSid === undefined || accountSid === '') missing.push('TWILIO_ACCOUNT_SID');
  if (authToken === undefined || authToken === '') missing.push('TWILIO_AUTH_TOKEN');
  if (phoneNumber === undefined || phoneNumber === '') missing.push('TWILIO_PHONE_NUMBER');
  if (missing.length > 0) {
    throw new Error(
      `EAL_API: TWILIO_ENABLED=true but these required env vars are missing or empty: ${missing.join(', ')}. ` +
        'Set them in the deploy environment; the trunk will not boot in a half-configured state.',
    );
  }
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid ?? '')) {
    throw new Error(
      `EAL_API: TWILIO_ACCOUNT_SID="${accountSid}" — expected an AC… SID of 34 chars.`,
    );
  }
  if (!E164.test(phoneNumber ?? '')) {
    throw new Error(
      `EAL_API: TWILIO_PHONE_NUMBER="${phoneNumber}" — expected an E.164 number (e.g. +441234567890).`,
    );
  }
  // Outbound caller ID. Optional: when unset it defaults to the trunk
  // DID (standard Twilio behaviour). When set it must be a valid E.164 —
  // an explicit-but-malformed value fails loud rather than silently
  // reverting to the DID. See the `callerId` field doc for the Italy
  // (AGCOM) reason this is separable from the inbound number.
  const callerIdRaw = env['TWILIO_CALLER_ID'];
  let callerId = phoneNumber ?? '';
  if (callerIdRaw !== undefined && callerIdRaw !== '') {
    if (!E164.test(callerIdRaw)) {
      throw new Error(
        `EAL_API: TWILIO_CALLER_ID="${callerIdRaw}" — expected an E.164 number (e.g. +441234567890).`,
      );
    }
    callerId = callerIdRaw;
  }
  const apiBaseUrl = env['TWILIO_API_BASE_URL'];
  const config: TwilioConfig = {
    accountSid: accountSid ?? '',
    authToken: authToken ?? '',
    phoneNumber: phoneNumber ?? '',
    callerId,
  };
  if (apiBaseUrl !== undefined && apiBaseUrl !== '') {
    if (!/^https?:\/\//.test(apiBaseUrl)) {
      throw new Error(
        `EAL_API: TWILIO_API_BASE_URL="${apiBaseUrl}" — expected an http(s) URL.`,
      );
    }
    config.apiBaseUrl = apiBaseUrl;
  }
  return config;
}
