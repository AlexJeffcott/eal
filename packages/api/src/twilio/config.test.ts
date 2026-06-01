import { describe, expect, test } from 'bun:test';
import { loadTwilioConfig } from './config.ts';

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return overrides;
}

const GOOD = {
  TWILIO_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: 'AC0123456789abcdef0123456789abcdef',
  TWILIO_AUTH_TOKEN: 'token-of-fixed-length',
  TWILIO_PHONE_NUMBER: '+441234567890',
  TWILIO_WEBHOOK_SIGNING_KEY: 'sig-key',
};

describe('loadTwilioConfig — gating', () => {
  test('returns null when TWILIO_ENABLED is unset', () => {
    expect(loadTwilioConfig(env({}))).toBeNull();
  });

  test('returns null when TWILIO_ENABLED is empty', () => {
    expect(loadTwilioConfig(env({ TWILIO_ENABLED: '' }))).toBeNull();
  });

  test('returns null when TWILIO_ENABLED is "false"', () => {
    expect(loadTwilioConfig(env({ TWILIO_ENABLED: 'false' }))).toBeNull();
  });

  test('rejects any other value of TWILIO_ENABLED with a loud error', () => {
    expect(() => loadTwilioConfig(env({ TWILIO_ENABLED: 'yes' }))).toThrow(/expected "true" or "false"/);
    expect(() => loadTwilioConfig(env({ TWILIO_ENABLED: '1' }))).toThrow(/expected "true" or "false"/);
  });
});

describe('loadTwilioConfig — required vars', () => {
  test('throws naming every missing var when enabled but underspecified', () => {
    expect(() =>
      loadTwilioConfig(env({ TWILIO_ENABLED: 'true' })),
    ).toThrow(/TWILIO_ACCOUNT_SID.*TWILIO_AUTH_TOKEN.*TWILIO_PHONE_NUMBER.*TWILIO_WEBHOOK_SIGNING_KEY/);
  });

  test('an empty-string value counts as missing — no silent default', () => {
    expect(() =>
      loadTwilioConfig(env({ ...GOOD, TWILIO_AUTH_TOKEN: '' })),
    ).toThrow(/TWILIO_AUTH_TOKEN/);
  });

  test('rejects a malformed account SID', () => {
    expect(() =>
      loadTwilioConfig(env({ ...GOOD, TWILIO_ACCOUNT_SID: 'AC123' })),
    ).toThrow(/AC… SID of 34 chars/);
  });

  test('rejects a non-E.164 phone number', () => {
    expect(() =>
      loadTwilioConfig(env({ ...GOOD, TWILIO_PHONE_NUMBER: '0123456789' })),
    ).toThrow(/E\.164/);
  });
});

describe('loadTwilioConfig — happy path', () => {
  test('returns the validated config when every var is present and well-formed', () => {
    const cfg = loadTwilioConfig(env(GOOD));
    expect(cfg).not.toBeNull();
    expect(cfg?.accountSid).toBe(GOOD.TWILIO_ACCOUNT_SID);
    expect(cfg?.authToken).toBe(GOOD.TWILIO_AUTH_TOKEN);
    expect(cfg?.phoneNumber).toBe(GOOD.TWILIO_PHONE_NUMBER);
    expect(cfg?.webhookSigningKey).toBe(GOOD.TWILIO_WEBHOOK_SIGNING_KEY);
  });
});
