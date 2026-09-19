import { describe, expect, test } from 'bun:test';
import { localDateToday } from './local-date.ts';

describe('localDateToday', () => {
  test('reads the local calendar date, zero-padded', () => {
    // Built from local components, so the assertion holds in any timezone the
    // suite runs in.
    expect(localDateToday(new Date(2026, 0, 5, 0, 30))).toBe('2026-01-05');
    expect(localDateToday(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });

  test('defaults to now', () => {
    expect(localDateToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
