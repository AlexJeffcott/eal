import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  dateOfDayNumber,
  dayNumber,
  defaultRecurrence,
  describeRecurrence,
  deserialiseRecurrence,
  isRealDate,
  MAX_INTERVAL_DAYS,
  nextOccurrence,
  parseRecurrence,
  type Recurrence,
  RecurrenceError,
  type RecurrenceKind,
  serialiseRecurrence,
  shiftDate,
  utcDateOf,
  validateToday,
  type Weekday,
  WEEKDAYS,
  weekdayOf,
} from './recurrence.ts';

/**
 * The calendar, checked against dates written down independently of the code:
 * a wall calendar, not `Date`.
 */
describe('calendar arithmetic', () => {
  test('known day numbers', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('1970-01-02')).toBe(1);
    expect(dayNumber('1969-12-31')).toBe(-1);
    expect(dayNumber('2000-03-01')).toBe(11017);
    expect(dayNumber('2026-09-19')).toBe(20715);
  });

  test('known weekdays', () => {
    expect(weekdayOf(dayNumber('1970-01-01'))).toBe('thu');
    expect(weekdayOf(dayNumber('2026-09-19'))).toBe('sat');
    expect(weekdayOf(dayNumber('2026-09-22'))).toBe('tue');
    expect(weekdayOf(dayNumber('2024-02-29'))).toBe('thu');
    expect(weekdayOf(dayNumber('1969-12-29'))).toBe('mon');
  });

  test('day numbers and dates round-trip, and consecutive numbers are consecutive days', () => {
    fc.assert(
      fc.property(fc.integer({ min: -200_000, max: 200_000 }), (n) => {
        expect(dayNumber(dateOfDayNumber(n))).toBe(n);
        expect(weekdayOf(n + 7)).toBe(weekdayOf(n));
        expect(weekdayOf(n + 1)).not.toBe(weekdayOf(n));
      }),
    );
  });

  test('a date that has the shape and does not exist is not real', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2024-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-04-31')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(isRealDate('2026-00-10')).toBe(false);
    expect(isRealDate('2026-1-1')).toBe(false);
    expect(isRealDate('2026-09-19T10:00:00Z')).toBe(false);
  });

  test('dayNumber refuses anything that is not a date', () => {
    expect(() => dayNumber('tomorrow')).toThrow(RecurrenceError);
    expect(() => dayNumber('2026-09-19T10:00:00Z')).toThrow('expected a YYYY-MM-DD date');
  });

  test('shiftDate moves the date part and keeps what follows it', () => {
    expect(shiftDate('2026-09-19', 7)).toBe('2026-09-26');
    expect(shiftDate('2026-12-30', 3)).toBe('2027-01-02');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-09-19T08:30:00+02:00', 14)).toBe('2026-10-03T08:30:00+02:00');
    expect(shiftDate('2026-09-19', 0)).toBe('2026-09-19');
  });

  test('utcDateOf reads the UTC calendar date of an instant', () => {
    expect(utcDateOf(new Date('2026-09-19T23:59:59Z'))).toBe('2026-09-19');
    // 00:30 in Rome on the 20th is still the 19th in UTC.
    expect(utcDateOf(new Date('2026-09-20T00:30:00+02:00'))).toBe('2026-09-19');
  });
});

describe('validateToday', () => {
  test('accepts the server date and one day either side', () => {
    expect(validateToday('2026-09-19', '2026-09-19')).toBe('2026-09-19');
    expect(validateToday('2026-09-20', '2026-09-19')).toBe('2026-09-20');
    expect(validateToday('2026-09-18', '2026-09-19')).toBe('2026-09-18');
    expect(validateToday('2027-01-01', '2026-12-31')).toBe('2027-01-01');
  });

  test('refuses a date more than a day from the server', () => {
    expect(() => validateToday('2026-09-21', '2026-09-19')).toThrow('more than a day apart');
    expect(() => validateToday('2026-09-17', '2026-09-19')).toThrow('more than a day apart');
    expect(() => validateToday('2027-09-19', '2026-09-19')).toThrow(RecurrenceError);
  });

  test('refuses a shape that is not a real date', () => {
    expect(() => validateToday('2026-02-30', '2026-03-01')).toThrow('real YYYY-MM-DD');
    expect(() => validateToday('today', '2026-09-19')).toThrow('real YYYY-MM-DD');
    expect(() => validateToday('2026-09-19T00:00:00Z', '2026-09-19')).toThrow(RecurrenceError);
  });
});

describe('parseRecurrence', () => {
  test('admits the four rules', () => {
    expect(parseRecurrence({ every: 'days', interval: 5, basis: 'completed' })).toEqual({
      every: 'days',
      interval: 5,
      basis: 'completed',
    });
    expect(parseRecurrence({ every: 'weekdays', basis: 'due' })).toEqual({
      every: 'weekdays',
      basis: 'due',
    });
    expect(parseRecurrence({ every: 'week', days: ['tue'], basis: 'due' })).toEqual({
      every: 'week',
      days: ['tue'],
      basis: 'due',
    });
    expect(parseRecurrence({ every: 'month', day: 31, basis: 'due' })).toEqual({
      every: 'month',
      day: 31,
      basis: 'due',
    });
  });

  test('weekly days come back deduplicated and in week order', () => {
    expect(
      parseRecurrence({ every: 'week', days: ['sun', 'tue', 'mon', 'tue'], basis: 'due' }),
    ).toEqual({ every: 'week', days: ['mon', 'tue', 'sun'], basis: 'due' });
  });

  test('refuses what is not an object', () => {
    for (const value of [null, undefined, 'weekly', 7, [], [{ every: 'weekdays', basis: 'due' }]]) {
      expect(() => parseRecurrence(value)).toThrow('recurrence must be an object');
    }
  });

  test('refuses an unknown rule', () => {
    expect(() => parseRecurrence({ every: 'year', basis: 'due' })).toThrow(
      'recurrence.every must be "days", "weekdays", "week" or "month"',
    );
    expect(() => parseRecurrence({ basis: 'due' })).toThrow('recurrence.every must be');
  });

  test('refuses an unknown field on every rule', () => {
    const cases: unknown[] = [
      { every: 'days', interval: 2, basis: 'due', until: '2027-01-01' },
      { every: 'weekdays', basis: 'due', interval: 2 },
      { every: 'week', days: ['mon'], basis: 'due', interval: 2 },
      { every: 'month', day: 1, basis: 'due', days: ['mon'] },
    ];
    for (const value of cases) {
      expect(() => parseRecurrence(value)).toThrow('unknown field');
    }
  });

  test('refuses a missing or unknown basis', () => {
    expect(() => parseRecurrence({ every: 'weekdays' })).toThrow(
      'recurrence.basis must be "due" or "completed"',
    );
    expect(() => parseRecurrence({ every: 'weekdays', basis: 'done' })).toThrow('recurrence.basis');
  });

  test('bounds the interval', () => {
    expect(parseRecurrence({ every: 'days', interval: 1, basis: 'due' }).every).toBe('days');
    expect(
      parseRecurrence({ every: 'days', interval: MAX_INTERVAL_DAYS, basis: 'due' }).every,
    ).toBe('days');
    for (const interval of [0, -1, 1.5, MAX_INTERVAL_DAYS + 1, '7', null, Number.NaN]) {
      expect(() => parseRecurrence({ every: 'days', interval, basis: 'due' })).toThrow(
        `recurrence.interval must be a whole number from 1 to ${MAX_INTERVAL_DAYS}`,
      );
    }
  });

  test('bounds the day of the month', () => {
    for (const day of [0, 32, 2.5, '15']) {
      expect(() => parseRecurrence({ every: 'month', day, basis: 'due' })).toThrow(
        'recurrence.day must be a whole number from 1 to 31',
      );
    }
  });

  test('a weekly rule needs at least one real weekday', () => {
    expect(() => parseRecurrence({ every: 'week', days: [], basis: 'due' })).toThrow(
      'at least one weekday',
    );
    expect(() => parseRecurrence({ every: 'week', days: 'tue', basis: 'due' })).toThrow(
      'at least one weekday',
    );
    expect(() => parseRecurrence({ every: 'week', days: ['tuesday'], basis: 'due' })).toThrow(
      'recurrence.days must hold only mon, tue, wed, thu, fri, sat, sun',
    );
    expect(() => parseRecurrence({ every: 'week', days: [2], basis: 'due' })).toThrow(
      'recurrence.days must hold only',
    );
  });

  test('the stored form round-trips, and one rule has one spelling', () => {
    const a = serialiseRecurrence({ every: 'week', days: ['fri', 'mon'], basis: 'due' });
    const b = serialiseRecurrence({ every: 'week', days: ['mon', 'fri', 'mon'], basis: 'due' });
    expect(a).toBe(b);
    expect(deserialiseRecurrence(a)).toEqual({ every: 'week', days: ['mon', 'fri'], basis: 'due' });
  });

  test('a stored value that is not a rule is refused, not ignored', () => {
    expect(() => deserialiseRecurrence('not json')).toThrow('stored recurrence is not JSON');
    expect(() => deserialiseRecurrence('{"every":"fortnight"}')).toThrow(RecurrenceError);
  });
});

describe('nextOccurrence — worked examples', () => {
  const tuesdays: Recurrence = { every: 'week', days: ['tue'], basis: 'due' };

  test('the bins: done on the day, next Tuesday', () => {
    expect(nextOccurrence(tuesdays, '2026-09-22', '2026-09-22')).toBe('2026-09-29');
  });

  test('never a backlog: three weeks late is next week, once', () => {
    // Due Tuesday the 1st, ticked on Saturday the 19th.
    expect(nextOccurrence(tuesdays, '2026-09-01', '2026-09-19')).toBe('2026-09-22');
  });

  test('done early, the next one is still after the one just done', () => {
    // Due Tuesday the 22nd, ticked the Saturday before.
    expect(nextOccurrence(tuesdays, '2026-09-22', '2026-09-19')).toBe('2026-09-29');
  });

  test('several days a week takes the nearest', () => {
    const rule: Recurrence = { every: 'week', days: ['mon', 'thu'], basis: 'due' };
    expect(nextOccurrence(rule, '2026-09-21', '2026-09-21')).toBe('2026-09-24');
    expect(nextOccurrence(rule, '2026-09-24', '2026-09-24')).toBe('2026-09-28');
  });

  test('weekdays skip the weekend', () => {
    const rule: Recurrence = { every: 'weekdays', basis: 'due' };
    expect(nextOccurrence(rule, '2026-09-18', '2026-09-18')).toBe('2026-09-21');
    expect(nextOccurrence(rule, '2026-09-21', '2026-09-21')).toBe('2026-09-22');
    expect(nextOccurrence(rule, '2026-09-19', '2026-09-19')).toBe('2026-09-21');
  });

  test('every N days keeps its phase when late', () => {
    const rule: Recurrence = { every: 'days', interval: 5, basis: 'due' };
    expect(nextOccurrence(rule, '2026-09-01', '2026-09-01')).toBe('2026-09-06');
    // Twelve days late: 06, 11 are gone; 16 is the first after the 13th.
    expect(nextOccurrence(rule, '2026-09-01', '2026-09-13')).toBe('2026-09-16');
    // Landing exactly on an occurrence is not strictly after it.
    expect(nextOccurrence(rule, '2026-09-01', '2026-09-11')).toBe('2026-09-16');
  });

  test('every N days after done counts from the day it was done', () => {
    const rule: Recurrence = { every: 'days', interval: 5, basis: 'completed' };
    expect(nextOccurrence(rule, '2026-09-19', '2026-09-19')).toBe('2026-09-24');
  });

  test('monthly on the 31st clamps through the short months and returns to the 31st', () => {
    const rule: Recurrence = { every: 'month', day: 31, basis: 'due' };
    expect(nextOccurrence(rule, '2026-01-31', '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrence(rule, '2026-02-28', '2026-02-28')).toBe('2026-03-31');
    expect(nextOccurrence(rule, '2026-03-31', '2026-03-31')).toBe('2026-04-30');
    expect(nextOccurrence(rule, '2024-01-31', '2024-01-31')).toBe('2024-02-29');
    expect(nextOccurrence(rule, '2026-12-31', '2026-12-31')).toBe('2027-01-31');
  });

  test('monthly mid-month takes this month when it has not come yet', () => {
    const rule: Recurrence = { every: 'month', day: 15, basis: 'due' };
    expect(nextOccurrence(rule, '2026-09-01', '2026-09-01')).toBe('2026-09-15');
    expect(nextOccurrence(rule, '2026-09-15', '2026-09-15')).toBe('2026-10-15');
    expect(nextOccurrence(rule, '2026-09-14', '2026-09-14')).toBe('2026-09-15');
  });

  test('a time on the anchor is carried, untouched, onto the result', () => {
    expect(nextOccurrence(tuesdays, '2026-09-22T08:30:00+02:00', '2026-09-22')).toBe(
      '2026-09-29T08:30:00+02:00',
    );
    expect(nextOccurrence(tuesdays, '2026-09-22T23:30:00Z', '2026-09-22')).toBe(
      '2026-09-29T23:30:00Z',
    );
  });

  test('the clocks changing moves nothing', () => {
    // Europe/Rome leaves summer time on 2026-10-25. A weekly task across it is
    // still seven calendar days on, at the same written time.
    expect(nextOccurrence(tuesdays, '2026-10-20T09:00:00+02:00', '2026-10-20')).toBe(
      '2026-10-27T09:00:00+02:00',
    );
    const daily: Recurrence = { every: 'days', interval: 1, basis: 'due' };
    expect(nextOccurrence(daily, '2026-10-24', '2026-10-24')).toBe('2026-10-25');
    expect(nextOccurrence(daily, '2026-10-25', '2026-10-25')).toBe('2026-10-26');
    expect(nextOccurrence(daily, '2026-03-28', '2026-03-28')).toBe('2026-03-29');
    expect(nextOccurrence(daily, '2026-03-29', '2026-03-29')).toBe('2026-03-30');
  });
});

// ─── The laws ───────────────────────────────────────────────────────────────

const basisArb = fc.constantFrom<'due' | 'completed'>('due', 'completed');
const weekdayArb = fc.constantFrom<Weekday>(...WEEKDAYS);

const ruleArb: fc.Arbitrary<Recurrence> = fc.oneof(
  fc.record({
    every: fc.constant<'days'>('days'),
    interval: fc.integer({ min: 1, max: MAX_INTERVAL_DAYS }),
    basis: basisArb,
  }),
  fc.record({ every: fc.constant<'weekdays'>('weekdays'), basis: basisArb }),
  fc
    .record({
      every: fc.constant<'week'>('week'),
      days: fc.uniqueArray(weekdayArb, { minLength: 1, maxLength: 7 }),
      basis: basisArb,
    })
    .map((rule) => parseRecurrence(rule)),
  fc.record({
    every: fc.constant<'month'>('month'),
    day: fc.integer({ min: 1, max: 31 }),
    basis: basisArb,
  }),
);

// 1990 to 2090, and a `today` up to two years either side of the anchor.
const anchorArb = fc.integer({ min: 7305, max: 43830 });
const gapArb = fc.integer({ min: -730, max: 730 });

/** Does this day satisfy the rule, given where the count started? */
function matches(rule: Recurrence, day: number, anchor: number): boolean {
  if (rule.every === 'days') return day > anchor && (day - anchor) % rule.interval === 0;
  if (rule.every === 'weekdays') return !['sat', 'sun'].includes(weekdayOf(day));
  if (rule.every === 'week') return rule.days.includes(weekdayOf(day));
  const date = dateOfDayNumber(day);
  const dayOfMonth = Number(date.slice(8, 10));
  if (dayOfMonth === rule.day) return true;
  // The clamp: the month's last day stands in for a day the month lacks.
  const isLastDay = dateOfDayNumber(day + 1).slice(8, 10) === '01';
  return isLastDay && dayOfMonth < rule.day;
}

describe('nextOccurrence — laws', () => {
  test('strictly after today, strictly after the anchor, and on a day the rule names', () => {
    fc.assert(
      fc.property(ruleArb, anchorArb, gapArb, (rule, anchor, gap) => {
        const today = anchor + gap;
        const next = dayNumber(nextOccurrence(rule, dateOfDayNumber(anchor), dateOfDayNumber(today)));
        expect(next).toBeGreaterThan(today);
        expect(next).toBeGreaterThan(anchor);
        expect(matches(rule, next, anchor)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  test('it is the FIRST such day: nothing the rule names lies between', () => {
    fc.assert(
      fc.property(ruleArb, anchorArb, gapArb, (rule, anchor, gap) => {
        const today = anchor + gap;
        const next = dayNumber(nextOccurrence(rule, dateOfDayNumber(anchor), dateOfDayNumber(today)));
        for (let day = Math.max(anchor, today) + 1; day < next; day++) {
          expect(matches(rule, day, anchor)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  test('applied twice it never moves backwards', () => {
    fc.assert(
      fc.property(ruleArb, anchorArb, gapArb, (rule, anchor, gap) => {
        const today = dateOfDayNumber(anchor + gap);
        const first = nextOccurrence(rule, dateOfDayNumber(anchor), today);
        const second = nextOccurrence(rule, first, today);
        expect(dayNumber(second)).toBeGreaterThan(dayNumber(first));
      }),
      { numRuns: 1000 },
    );
  });

  test('monthly: the result is day N, or the last day of a month that has no day N', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 31 }), anchorArb, (day, anchor) => {
        const rule: Recurrence = { every: 'month', day, basis: 'due' };
        let cursor = dateOfDayNumber(anchor);
        // A year of occurrences: every month appears, February included.
        for (let i = 0; i < 12; i++) {
          const next = nextOccurrence(rule, cursor, cursor);
          const dayOfMonth = Number(next.slice(8, 10));
          const lastOfMonth = Number(
            dateOfDayNumber(dayNumber(`${shiftMonth(next)}-01`) - 1).slice(8, 10),
          );
          expect(dayOfMonth).toBe(Math.min(day, lastOfMonth));
          // Exactly one occurrence a month: once on the series, each step
          // lands in the month after the last. (The first step starts from an
          // arbitrary day, so it may stay in its own month.)
          if (i > 0) expect(next.slice(0, 7)).toBe(shiftMonth(cursor));
          cursor = next;
        }
      }),
      { numRuns: 300 },
    );
  });

  test('a suffix on the anchor never changes the date, and always survives', () => {
    const suffixArb = fc.constantFrom('', 'T08:30:00Z', 'T23:59:59+02:00', 'T00:00:00.000-05:00');
    fc.assert(
      fc.property(ruleArb, anchorArb, gapArb, suffixArb, (rule, anchor, gap, suffix) => {
        const today = dateOfDayNumber(anchor + gap);
        const bare = nextOccurrence(rule, dateOfDayNumber(anchor), today);
        const timed = nextOccurrence(rule, dateOfDayNumber(anchor) + suffix, today);
        expect(timed).toBe(bare + suffix);
      }),
      { numRuns: 500 },
    );
  });
});

/** `YYYY-MM` of the month after the one `date` is in. */
function shiftMonth(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

describe('describeRecurrence', () => {
  const cases: ReadonlyArray<[Recurrence, string]> = [
    [{ every: 'week', days: ['tue'], basis: 'due' }, 'Every Tuesday'],
    [{ every: 'week', days: ['mon', 'thu'], basis: 'due' }, 'Every Monday and Thursday'],
    [
      { every: 'week', days: ['mon', 'wed', 'fri'], basis: 'due' },
      'Every Monday, Wednesday and Friday',
    ],
    [{ every: 'week', days: [...WEEKDAYS], basis: 'due' }, 'Every day'],
    [{ every: 'week', days: ['sat'], basis: 'completed' }, 'Every Saturday after done'],
    [{ every: 'days', interval: 5, basis: 'completed' }, 'Every 5 days after done'],
    [{ every: 'days', interval: 5, basis: 'due' }, 'Every 5 days'],
    [{ every: 'days', interval: 1, basis: 'due' }, 'Every day'],
    [{ every: 'days', interval: 1, basis: 'completed' }, 'Every day after done'],
    [{ every: 'weekdays', basis: 'due' }, 'Every weekday'],
    [{ every: 'weekdays', basis: 'completed' }, 'Every weekday after done'],
    [{ every: 'month', day: 31, basis: 'due' }, 'Monthly on the 31st'],
    [{ every: 'month', day: 1, basis: 'due' }, 'Monthly on the 1st'],
    [{ every: 'month', day: 2, basis: 'due' }, 'Monthly on the 2nd'],
    [{ every: 'month', day: 3, basis: 'due' }, 'Monthly on the 3rd'],
    [{ every: 'month', day: 4, basis: 'due' }, 'Monthly on the 4th'],
    [{ every: 'month', day: 11, basis: 'due' }, 'Monthly on the 11th'],
    [{ every: 'month', day: 12, basis: 'due' }, 'Monthly on the 12th'],
    [{ every: 'month', day: 13, basis: 'due' }, 'Monthly on the 13th'],
    [{ every: 'month', day: 21, basis: 'due' }, 'Monthly on the 21st'],
    [{ every: 'month', day: 22, basis: 'due' }, 'Monthly on the 22nd'],
    [{ every: 'month', day: 23, basis: 'completed' }, 'Monthly on the 23rd after done'],
  ];
  for (const [rule, words] of cases) {
    test(words, () => {
      expect(describeRecurrence(rule)).toBe(words);
    });
  }
});

describe('defaultRecurrence', () => {
  test('reads the weekday and the day of the month from the hint', () => {
    expect(defaultRecurrence('week', '2026-09-22')).toEqual({
      every: 'week',
      days: ['tue'],
      basis: 'due',
    });
    expect(defaultRecurrence('month', '2026-09-22T08:00:00Z')).toEqual({
      every: 'month',
      day: 22,
      basis: 'due',
    });
    expect(defaultRecurrence('days', '2026-09-22')).toEqual({
      every: 'days',
      interval: 1,
      basis: 'due',
    });
    expect(defaultRecurrence('weekdays', '2026-09-22')).toEqual({ every: 'weekdays', basis: 'due' });
  });

  test('every default is a rule the parser admits', () => {
    const kinds: readonly RecurrenceKind[] = ['days', 'weekdays', 'week', 'month'];
    for (const kind of kinds) {
      const rule = defaultRecurrence(kind, '2026-01-31');
      expect(parseRecurrence(rule)).toEqual(rule);
    }
  });
});
