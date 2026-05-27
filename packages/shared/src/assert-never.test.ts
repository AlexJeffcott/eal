import { describe, expect, test } from 'bun:test';
import { assertNever } from './assert-never.ts';

/**
 * `assertNever` exists for the moment the type system has been lied to —
 * a JSON payload that does not match its declared shape, an external
 * input that widens past the compile-time union. The test reproduces
 * exactly that: `JSON.parse` returns `any`, so the assignment to a
 * narrow union type is accepted by the compiler, but the runtime value
 * falls through every case to the `default` arm.
 */
type RuleKind = 'place_call' | 'voice_message';

describe('assertNever', () => {
  test('throws when the switch falls through to the default arm', () => {
    const value: RuleKind = JSON.parse('"bogus"');
    let caught: unknown = null;
    switch (value) {
      case 'place_call':
        break;
      case 'voice_message':
        break;
      default:
        try {
          assertNever(value);
        } catch (err) {
          caught = err;
        }
        break;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toMatch(/unexpected value: "bogus"/);
  });

  test('serialises an unexpected object into the message', () => {
    const value: RuleKind = JSON.parse('{"kind":"mystery"}');
    let caught: unknown = null;
    switch (value) {
      case 'place_call':
        break;
      case 'voice_message':
        break;
      default:
        try {
          assertNever(value);
        } catch (err) {
          caught = err;
        }
        break;
    }
    expect(String(caught)).toMatch(/unexpected value: \{"kind":"mystery"\}/);
  });
});
