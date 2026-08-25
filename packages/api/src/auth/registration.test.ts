import { describe, expect, test } from 'bun:test';
import {
  createRegistrationThrottle,
  DEFAULT_FAILURE_WINDOW_MS,
  DEFAULT_MAX_FAILURES,
  inviteCodeMatches,
  loadRegistrationConfig,
  MIN_INVITE_CODE_LENGTH,
} from './registration.ts';

const GOOD_CODE = 'a'.repeat(MIN_INVITE_CODE_LENGTH);

describe('loadRegistrationConfig', () => {
  test('an empty environment closes registration', () => {
    expect(loadRegistrationConfig({})).toEqual({ inviteCode: null });
  });

  test('an empty string closes registration', () => {
    expect(loadRegistrationConfig({ EAL_INVITE_CODE: '' })).toEqual({ inviteCode: null });
  });

  test('whitespace only closes registration', () => {
    expect(loadRegistrationConfig({ EAL_INVITE_CODE: '   ' })).toEqual({ inviteCode: null });
  });

  test('a code at the minimum length is accepted, trimmed', () => {
    expect(loadRegistrationConfig({ EAL_INVITE_CODE: ` ${GOOD_CODE} ` })).toEqual({
      inviteCode: GOOD_CODE,
    });
  });

  test('a short code fails the boot loudly, naming both lengths', () => {
    const short = 'a'.repeat(MIN_INVITE_CODE_LENGTH - 1);
    expect(() => loadRegistrationConfig({ EAL_INVITE_CODE: short })).toThrow(
      new RegExp(`${MIN_INVITE_CODE_LENGTH - 1} characters.*minimum is ${MIN_INVITE_CODE_LENGTH}`),
    );
  });
});

describe('inviteCodeMatches', () => {
  test('an identical code matches', () => {
    expect(inviteCodeMatches(GOOD_CODE, GOOD_CODE)).toBe(true);
  });

  test('a different code of the same length does not match', () => {
    expect(inviteCodeMatches(GOOD_CODE, 'b'.repeat(MIN_INVITE_CODE_LENGTH))).toBe(false);
  });

  test('a different length does not throw — it returns false', () => {
    expect(inviteCodeMatches(GOOD_CODE, '')).toBe(false);
    expect(inviteCodeMatches(GOOD_CODE, `${GOOD_CODE}x`)).toBe(false);
  });

  test('a prefix of the real code does not match', () => {
    expect(inviteCodeMatches(GOOD_CODE, GOOD_CODE.slice(0, -1))).toBe(false);
  });
});

describe('createRegistrationThrottle', () => {
  test('a fresh throttle allows, and reports no failures', () => {
    const throttle = createRegistrationThrottle({ now: () => 0 });
    expect(throttle.check()).toEqual({ allowed: true, failures: 0, retryAfterSec: 0 });
  });

  test('it allows up to the cap and refuses the next check', () => {
    const throttle = createRegistrationThrottle({ maxFailures: 3, now: () => 0 });
    throttle.recordFailure();
    throttle.recordFailure();
    expect(throttle.check().allowed).toBe(true);
    throttle.recordFailure();
    expect(throttle.check()).toEqual({
      allowed: false,
      failures: 3,
      retryAfterSec: DEFAULT_FAILURE_WINDOW_MS / 1000,
    });
  });

  test('failures leave the window and the gate reopens', () => {
    let clock = 0;
    const throttle = createRegistrationThrottle({
      maxFailures: 2,
      windowMs: 1000,
      now: () => clock,
    });
    throttle.recordFailure();
    throttle.recordFailure();
    expect(throttle.check().allowed).toBe(false);
    clock = 1001;
    expect(throttle.check()).toEqual({ allowed: true, failures: 0, retryAfterSec: 0 });
  });

  test('retryAfterSec counts from the oldest failure still in the window', () => {
    let clock = 0;
    const throttle = createRegistrationThrottle({
      maxFailures: 2,
      windowMs: 10_000,
      now: () => clock,
    });
    throttle.recordFailure();
    clock = 4000;
    throttle.recordFailure();
    clock = 5000;
    // The oldest failure was at 0 and leaves the window at 10_000.
    expect(throttle.check().retryAfterSec).toBe(5);
  });

  test('the default cap is 10 failures', () => {
    const throttle = createRegistrationThrottle({ now: () => 0 });
    for (let i = 0; i < DEFAULT_MAX_FAILURES; i += 1) throttle.recordFailure();
    expect(throttle.check().allowed).toBe(false);
  });
});
