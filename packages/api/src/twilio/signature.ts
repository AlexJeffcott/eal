import { createHmac } from 'node:crypto';

/**
 * Verify a Twilio webhook request against the X-Twilio-Signature header.
 *
 * Twilio's algorithm (https://www.twilio.com/docs/usage/webhooks/webhooks-security):
 *   1. Take the full request URL (including query string).
 *   2. For application/x-www-form-urlencoded POSTs, append each parameter
 *      sorted alphabetically by name, with name and value concatenated
 *      (no separator between the pairs).
 *   3. Compute HMAC-SHA1 with the auth token as the key.
 *   4. Base64-encode the digest.
 *   5. Compare against the X-Twilio-Signature header in constant time.
 *
 * This module is pure — no network, no env reads — so the webhook handler
 * can pass in already-parsed form fields from any source (Elysia, a test
 * harness, a fuzzer).
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  formFields: Record<string, string>,
): string {
  const keys = Object.keys(formFields).sort();
  let payload = url;
  for (const key of keys) payload += key + (formFields[key] ?? '');
  return createHmac('sha1', authToken).update(payload).digest('base64');
}

/**
 * Constant-time string comparison — guards against the timing oracle a
 * naive `===` would leak when checking webhook signatures.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * The standard verify entry point — takes everything from the wire,
 * returns true iff the signature matches. Returns false on missing
 * inputs so callers can treat unauthenticated and forged requests
 * identically.
 */
export function verifyTwilioSignature(input: {
  authToken: string;
  url: string;
  formFields: Record<string, string>;
  signatureHeader: string | null;
}): boolean {
  if (input.signatureHeader === null || input.signatureHeader === '') return false;
  const expected = computeTwilioSignature(input.authToken, input.url, input.formFields);
  return constantTimeEqual(expected, input.signatureHeader);
}
