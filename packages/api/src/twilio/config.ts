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
  /** The household's E.164 trunk number — both the inbound DID and the
   * outbound caller ID. */
  phoneNumber: string;
  /** Token verified against the X-Twilio-Signature header on every
   * webhook so an attacker can't spoof inbound calls into the bridge. */
  webhookSigningKey: string;
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
  const webhookSigningKey = env['TWILIO_WEBHOOK_SIGNING_KEY'];
  const missing: string[] = [];
  if (accountSid === undefined || accountSid === '') missing.push('TWILIO_ACCOUNT_SID');
  if (authToken === undefined || authToken === '') missing.push('TWILIO_AUTH_TOKEN');
  if (phoneNumber === undefined || phoneNumber === '') missing.push('TWILIO_PHONE_NUMBER');
  if (webhookSigningKey === undefined || webhookSigningKey === '') {
    missing.push('TWILIO_WEBHOOK_SIGNING_KEY');
  }
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
  if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber ?? '')) {
    throw new Error(
      `EAL_API: TWILIO_PHONE_NUMBER="${phoneNumber}" — expected an E.164 number (e.g. +441234567890).`,
    );
  }
  const apiBaseUrl = env['TWILIO_API_BASE_URL'];
  const config: TwilioConfig = {
    accountSid: accountSid ?? '',
    authToken: authToken ?? '',
    phoneNumber: phoneNumber ?? '',
    webhookSigningKey: webhookSigningKey ?? '',
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
