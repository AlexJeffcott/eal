import { describe, test } from 'bun:test';
import fc from 'fast-check';
import { formatSqliteDateTime, parseSqliteDateTime } from './datetime.ts';

// fc.date can produce `new Date(NaN)` via `noInvalidDate: false`; we use
// epoch-ms integers + new Date(ms) to guarantee validity.
const epochMs = fc.integer({
  min: new Date('2000-01-01').getTime(),
  max: new Date('2099-12-31').getTime(),
});

describe('datetime helpers (property-based)', () => {
  test('formatSqliteDateTime always produces "YYYY-MM-DD HH:MM:SS"', () => {
    fc.assert(
      fc.property(epochMs, (ms) => {
        const s = formatSqliteDateTime(new Date(ms));
        return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s);
      }),
    );
  });

  test('format → parse round-trip preserves the original instant to second precision', () => {
    fc.assert(
      fc.property(epochMs, (ms) => {
        const floored = new Date(Math.floor(ms / 1000) * 1000);
        const parsed = parseSqliteDateTime(formatSqliteDateTime(floored));
        return parsed.getTime() === floored.getTime();
      }),
    );
  });

  test('formatted output is lexically orderable in the same order as Date.getTime', () => {
    fc.assert(
      fc.property(epochMs, epochMs, (a, b) => {
        const fa = formatSqliteDateTime(new Date(a));
        const fb = formatSqliteDateTime(new Date(b));
        const aFloor = Math.floor(a / 1000);
        const bFloor = Math.floor(b / 1000);
        if (aFloor === bFloor) return fa === fb;
        return aFloor < bFloor ? fa < fb : fa > fb;
      }),
    );
  });
});
