import { describe, expect, test } from 'bun:test';
import {
  computeTwilioSignature,
  constantTimeEqual,
  verifyTwilioSignature,
} from './signature.ts';

const TOKEN = 'auth-token-for-signature-tests';
const URL_ = 'https://example.com/api/family-phone/twilio/voice';

describe('computeTwilioSignature', () => {
  test('with no form fields signs just the URL', () => {
    const sig = computeTwilioSignature(TOKEN, URL_, {});
    expect(sig.length).toBeGreaterThan(0);
    // Idempotent for the same inputs.
    expect(computeTwilioSignature(TOKEN, URL_, {})).toBe(sig);
  });

  test('field order in the input map does not affect the signature', () => {
    const a = computeTwilioSignature(TOKEN, URL_, { From: '+1', To: '+2', CallSid: 'CA1' });
    const b = computeTwilioSignature(TOKEN, URL_, { To: '+2', CallSid: 'CA1', From: '+1' });
    expect(a).toBe(b);
  });

  test('changing any field flips the signature', () => {
    const base = computeTwilioSignature(TOKEN, URL_, { From: '+1' });
    expect(computeTwilioSignature(TOKEN, URL_, { From: '+2' })).not.toBe(base);
    expect(computeTwilioSignature(TOKEN, URL_, { To: '+1' })).not.toBe(base);
    expect(computeTwilioSignature(TOKEN, URL_, {})).not.toBe(base);
    expect(computeTwilioSignature('different-token', URL_, { From: '+1' })).not.toBe(base);
    expect(computeTwilioSignature(TOKEN, `${URL_}?x=1`, { From: '+1' })).not.toBe(base);
  });
});

describe('constantTimeEqual', () => {
  test('matches identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
  });

  test('rejects different lengths', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  test('rejects same-length but different content', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });

  test('treats empty strings as equal', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('verifyTwilioSignature', () => {
  test('returns true for a freshly computed signature', () => {
    const fields = { From: '+12025550100', To: '+441234567890', CallSid: 'CA1234' };
    const expected = computeTwilioSignature(TOKEN, URL_, fields);
    expect(
      verifyTwilioSignature({
        authToken: TOKEN,
        url: URL_,
        formFields: fields,
        signatureHeader: expected,
      }),
    ).toBe(true);
  });

  test('returns false on a missing signature header', () => {
    expect(
      verifyTwilioSignature({
        authToken: TOKEN,
        url: URL_,
        formFields: { From: '+1' },
        signatureHeader: null,
      }),
    ).toBe(false);
    expect(
      verifyTwilioSignature({
        authToken: TOKEN,
        url: URL_,
        formFields: { From: '+1' },
        signatureHeader: '',
      }),
    ).toBe(false);
  });

  test('returns false on a tampered field', () => {
    const original = { From: '+1', To: '+2' };
    const sig = computeTwilioSignature(TOKEN, URL_, original);
    const tampered = { From: '+999', To: '+2' };
    expect(
      verifyTwilioSignature({
        authToken: TOKEN,
        url: URL_,
        formFields: tampered,
        signatureHeader: sig,
      }),
    ).toBe(false);
  });

  test('returns false on the wrong auth token', () => {
    const fields = { From: '+1' };
    const sig = computeTwilioSignature('right-token', URL_, fields);
    expect(
      verifyTwilioSignature({
        authToken: 'wrong-token',
        url: URL_,
        formFields: fields,
        signatureHeader: sig,
      }),
    ).toBe(false);
  });
});
