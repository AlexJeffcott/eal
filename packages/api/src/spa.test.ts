import { describe, expect, test } from 'bun:test';
import { resolveSwKill } from './spa.ts';

describe('resolveSwKill', () => {
  test('unset, empty and "0" are off', () => {
    expect(resolveSwKill({})).toBe(false);
    expect(resolveSwKill({ EAL_SW_KILL: '' })).toBe(false);
    expect(resolveSwKill({ EAL_SW_KILL: '0' })).toBe(false);
  });

  test('"1" is on', () => {
    expect(resolveSwKill({ EAL_SW_KILL: '1' })).toBe(true);
  });

  test('any other value refuses to boot — a typo must not read as off', () => {
    for (const raw of ['true', 'yes', '01', ' 1', 'on']) {
      expect(() => resolveSwKill({ EAL_SW_KILL: raw })).toThrow(
        `EAL_API: EAL_SW_KILL="${raw}" — expected "0" or "1" (or unset).`,
      );
    }
  });
});
