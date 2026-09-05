import { describe, expect, test } from 'bun:test';
import { friendlyRegisterError, friendlySignInError } from '../shell/actions.ts';
import { friendlyTaskError } from '../apps/tasks/actions.ts';

/**
 * Each row pins down a specific branch of the friendly mappers.
 *
 * The `match` strings must occur exactly in the rendered output. They are the
 * actual user-facing copy — if the visible message wording changes, the test
 * fails and the team has to decide whether the new wording was intentional.
 *
 * The mappers consume arbitrary server / browser error strings (raw, not
 * structured codes) so the tests anchor on the substrings the mappers look
 * for. The webauthn-related strings come from packages/api/src/auth/webauthn.ts
 * and from the browser's DOMException family — keep both ends in sync.
 */

const SIGN_IN_RAW_TO_FRIENDLY: ReadonlyArray<[label: string, raw: string, contains: string]> = [
  ['DOMException name from passkey UI', 'NotAllowedError: …', 'Sign-in cancelled'],
  ['DOMException message variant', 'The operation was cancelled by the user.', 'Sign-in cancelled'],
  ['mixed-case "cancel" still matches', 'CANCELLED by user', 'Sign-in cancelled'],
  ['server: unknown credential', 'webauthn: credential not found', "don't recognise that passkey"],
  ['server: replay detected', 'webauthn: counter rollback detected (replay)', 'replayed'],
  ['server: challenge expired', 'webauthn: no pending authentication challenge', 'took too long'],
  ['server: signature mismatch', 'webauthn: authentication response failed verification', "didn't verify"],
];

const REGISTER_RAW_TO_FRIENDLY: ReadonlyArray<[label: string, raw: string, contains: string]> = [
  ['DOMException name from passkey UI', 'NotAllowedError: …', 'Registration cancelled'],
  ['DOMException message variant', 'The user cancelled the request.', 'Registration cancelled'],
  ['server: registration verification failed', 'webauthn: registration response failed verification', "didn't verify"],
  ['server: registration challenge expired', 'webauthn: no pending registration challenge', 'took too long'],
  // The registration gate — packages/api/src/auth/registration.ts emits these
  // three raw strings, and the sign-in card is the only place a person reads
  // them. A drift in either half loses the explanation.
  ['server: gate closed', 'registration is closed', 'not accepting new devices'],
  ['server: wrong invite code', 'invalid invite code', 'invite code is wrong'],
  [
    'server: too many wrong codes',
    'too many registration attempts — try again in 300s',
    'Too many wrong invite codes',
  ],
];

describe('friendlySignInError', () => {
  for (const [label, raw, contains] of SIGN_IN_RAW_TO_FRIENDLY) {
    test(`${label}: maps "${raw}" → message containing "${contains}"`, () => {
      const friendly = friendlySignInError(new Error(raw));
      expect(friendly).toContain(contains);
      // The mapping must REPLACE the raw — never just prepend the raw text.
      expect(friendly).not.toBe(raw);
    });
  }

  test('unknown error message falls through unchanged', () => {
    const raw = 'something the api hasn’t mapped yet (id=7)';
    expect(friendlySignInError(new Error(raw))).toBe(raw);
  });

  test('non-Error inputs are stringified, not silently swallowed', () => {
    expect(friendlySignInError('a bare string')).toBe('a bare string');
    expect(friendlySignInError(42)).toBe('42');
    expect(friendlySignInError(null)).toBe('null');
    expect(friendlySignInError(undefined)).toBe('undefined');
  });

  test('does NOT map register-only phrases (no cross-domain bleed)', () => {
    const raw = 'webauthn: registration response failed verification';
    // Friendly sign-in must surface the raw so engineers can triage — but
    // it must not lie about WHICH ceremony failed.
    const out = friendlySignInError(new Error(raw));
    expect(out).toBe(raw);
    expect(out).not.toContain('Registration cancelled');
  });

  test('substring discipline: "credential" alone is not enough to trigger the not-found copy', () => {
    // Future regression guard: if someone widens the match to /credential/i,
    // an unrelated message like "credential storage quota exceeded" would
    // incorrectly suggest the user hasn't registered.
    const raw = 'credential storage quota exceeded';
    expect(friendlySignInError(new Error(raw))).toBe(raw);
  });
});

describe('friendlyRegisterError', () => {
  for (const [label, raw, contains] of REGISTER_RAW_TO_FRIENDLY) {
    test(`${label}: maps "${raw}" → message containing "${contains}"`, () => {
      const friendly = friendlyRegisterError(new Error(raw));
      expect(friendly).toContain(contains);
      expect(friendly).not.toBe(raw);
    });
  }

  test('unknown error message falls through unchanged', () => {
    const raw = 'unknown register failure';
    expect(friendlyRegisterError(new Error(raw))).toBe(raw);
  });

  test('non-Error inputs are stringified', () => {
    expect(friendlyRegisterError('raw')).toBe('raw');
    expect(friendlyRegisterError(null)).toBe('null');
  });

  test('does NOT map sign-in-only phrases (no cross-domain bleed)', () => {
    // "credential not found" only ever surfaces from the LOGIN path on the
    // server side. If a future change wires it into the register path too,
    // this test must be updated deliberately.
    const raw = 'webauthn: credential not found';
    const out = friendlyRegisterError(new Error(raw));
    expect(out).toBe(raw);
    expect(out).not.toContain("don't recognise");
  });
});

/**
 * The level rules are enforced server-side and can only be enforced there —
 * they read the parent row, which a CHECK constraint cannot reach. So the only
 * way a person learns why a move was refused is this mapper, and the only link
 * between the two halves is a substring. The raw column below is copied from
 * packages/api/src/handlers/tasks.shared.ts:levelViolation; a reword at either
 * end must break this test rather than quietly showing server prose on a phone.
 */
const TASK_RAW_TO_FRIENDLY: ReadonlyArray<[label: string, raw: string, contains: string]> = [
  ['title', 'title is required', 'Give the task a title'],
  [
    'cycle',
    'would create cycle: cannot parent a task under itself or its descendants',
    "can't move a task inside itself",
  ],
  [
    'project under something',
    'a project cannot be filed under another task',
    'A project sits at the top level',
  ],
  ['loose epic', 'an epic must be filed under a project', 'An epic has to sit inside a project'],
  [
    'task under a task',
    'a task cannot be filed under another task',
    'Make it a project or an epic first',
  ],
  [
    'a demotion that would strand children',
    'task 12 would no longer fit under it: a task cannot be filed under another task',
    'Move it out first',
  ],
];

describe('friendlyTaskError', () => {
  for (const [label, raw, contains] of TASK_RAW_TO_FRIENDLY) {
    test(`${label}: maps "${raw}" → message containing "${contains}"`, () => {
      const friendly = friendlyTaskError(new Error(raw));
      expect(friendly).toContain(contains);
      expect(friendly).not.toBe(raw);
    });
  }

  test('the stranded-children message beats the pairing it quotes', () => {
    // It ends with the very phrase the "task under a task" row matches, so
    // order in the mapper is load-bearing: the specific advice ("move the
    // children out") must win over the general one ("promote this row").
    const raw = 'task 12 would no longer fit under it: a task cannot be filed under another task';
    expect(friendlyTaskError(new Error(raw))).not.toContain('Make it a project or an epic first');
  });

  test('unknown error message falls through unchanged', () => {
    const raw = 'something the tasks api hasn’t mapped yet (id=7)';
    expect(friendlyTaskError(new Error(raw))).toBe(raw);
  });

  test('non-Error inputs are stringified', () => {
    expect(friendlyTaskError('a bare string')).toBe('a bare string');
    expect(friendlyTaskError(null)).toBe('null');
  });
});
