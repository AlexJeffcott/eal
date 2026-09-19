/**
 * Recurring tasks — the rule, its parser, and the one function that says when
 * the next occurrence falls. `docs/plans/05-recurring-tasks.md`.
 *
 * A small fixed set, not RFC 5545: every N days, weekdays, weekly on given
 * days, monthly on day N. Each carries a `basis`:
 *
 *   due        the bins go out every Tuesday — count from the previous due date
 *   completed  water the plants every 5 days — count from the day it was done
 *
 * Everything here works on CALENDAR DATES, never on instants. A due date is
 * what `<input type=date>` produced — `YYYY-MM-DD`, stored as typed and shown
 * by its first ten characters — so "a week later" is seven calendar days, and
 * no daylight-saving change can move it. There is deliberately no `Date` in
 * this file: dates become a day count (days since 1970-01-01 in the proleptic
 * Gregorian calendar) by integer arithmetic, and come back the same way.
 *
 * Shared, because three packages need one answer: the api computes the
 * successor, the SPA describes the rule in words, and the assistant's tools
 * validate one before sending it.
 */

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type RecurrenceBasis = 'due' | 'completed';

export type Recurrence =
  | { every: 'days'; interval: number; basis: RecurrenceBasis }
  | { every: 'weekdays'; basis: RecurrenceBasis }
  | { every: 'week'; days: Weekday[]; basis: RecurrenceBasis }
  | { every: 'month'; day: number; basis: RecurrenceBasis };

export type RecurrenceKind = Recurrence['every'];

/** Monday first — the order the week runs in, and the order `days` is stored in. */
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** A year of days. Anything longer is a date, not a rhythm. */
export const MAX_INTERVAL_DAYS = 365;

/** A rule, or a `today`, that the boundary refuses. The api answers 400. */
export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceError';
  }
}

// ─── Calendar arithmetic ────────────────────────────────────────────────────

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Days since 1970-01-01 for a civil date. Howard Hinnant's `days_from_civil`:
 * exact over the whole proleptic Gregorian calendar, integers only.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse of `daysFromCivil`. */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** The day count of a `YYYY-MM-DD`. Throws on any other shape. */
export function dayNumber(date: string): number {
  const match = DATE_ONLY.exec(date);
  if (match === null) throw new RecurrenceError(`expected a YYYY-MM-DD date, got "${date}"`);
  return daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** The `YYYY-MM-DD` of a day count. */
export function dateOfDayNumber(days: number): string {
  const { year, month, day } = civilFromDays(days);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Is this `YYYY-MM-DD` a day that exists? `2026-02-30` has the shape and is not. */
export function isRealDate(date: string): boolean {
  if (!DATE_ONLY.test(date)) return false;
  return dateOfDayNumber(dayNumber(date)) === date;
}

/** 1970-01-01 was a Thursday, which is index 3 with Monday first. */
export function weekdayOf(days: number): Weekday {
  const index = (((days + 3) % 7) + 7) % 7;
  const name = WEEKDAYS[index];
  if (name === undefined) throw new Error(`weekdayOf: index ${index} out of range`);
  return name;
}

function daysInMonth(year: number, month: number): number {
  const next = month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, month + 1, 1);
  return next - daysFromCivil(year, month, 1);
}

/** Move a date, or the date part of a timestamp, by whole calendar days. */
export function shiftDate(value: string, deltaDays: number): string {
  return dateOfDayNumber(dayNumber(value.slice(0, 10)) + deltaDays) + value.slice(10);
}

/**
 * The calendar date an instant falls on in UTC. The one place a clock meets
 * this file, and the clock is the caller's: the api uses it when a request does
 * not say what day it is where the person is standing.
 */
export function utcDateOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Admit the `today` a device sent with a completion.
 *
 * The server runs in UTC and the household does not: at 00:30 in Rome the UTC
 * date is still yesterday, and "the first occurrence strictly after today"
 * would land on the wrong day. So the device says what day it is. No timezone
 * is more than a day from UTC's date, which is the whole check: a value further
 * out than that is a wrong clock or a forged request, and either way it must
 * not be able to schedule a task into next year.
 */
export function validateToday(today: string, serverUtcDate: string): string {
  if (!isRealDate(today)) {
    throw new RecurrenceError(`today must be a real YYYY-MM-DD date, got "${today}"`);
  }
  if (Math.abs(dayNumber(today) - dayNumber(serverUtcDate)) > 1) {
    throw new RecurrenceError(
      `today is "${today}" and the server's date is ${serverUtcDate}: more than a day apart`,
    );
  }
  return today;
}

// ─── The rule ───────────────────────────────────────────────────────────────

function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'string' && WEEKDAYS.some((d) => d === value);
}

function requireKeys(value: object, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RecurrenceError(`recurrence has an unknown field "${key}"`);
    }
  }
}

function requireBasis(value: object): RecurrenceBasis {
  const basis: unknown = Reflect.get(value, 'basis');
  if (basis === 'due' || basis === 'completed') return basis;
  throw new RecurrenceError('recurrence.basis must be "due" or "completed"');
}

function requireInteger(value: object, field: string, min: number, max: number): number {
  const raw: unknown = Reflect.get(value, field);
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new RecurrenceError(`recurrence.${field} must be a whole number from ${min} to ${max}`);
  }
  return raw;
}

/**
 * The boundary. Anything that is not exactly one of the four rules is refused:
 * an unknown field is a typo or a rule this code cannot honour, and storing it
 * would mean silently ignoring part of what the person asked for.
 *
 * The result is canonical — weekly days deduplicated and in week order — so one
 * rule has one stored spelling.
 */
export function parseRecurrence(value: unknown): Recurrence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RecurrenceError('recurrence must be an object');
  }
  const every: unknown = Reflect.get(value, 'every');
  if (every === 'days') {
    requireKeys(value, ['every', 'interval', 'basis']);
    return {
      every,
      interval: requireInteger(value, 'interval', 1, MAX_INTERVAL_DAYS),
      basis: requireBasis(value),
    };
  }
  if (every === 'weekdays') {
    requireKeys(value, ['every', 'basis']);
    return { every, basis: requireBasis(value) };
  }
  if (every === 'week') {
    requireKeys(value, ['every', 'days', 'basis']);
    const raw: unknown = Reflect.get(value, 'days');
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new RecurrenceError('recurrence.days must name at least one weekday');
    }
    const named: Weekday[] = [];
    for (const day of raw) {
      if (!isWeekday(day)) {
        throw new RecurrenceError(`recurrence.days must hold only ${WEEKDAYS.join(', ')}`);
      }
      named.push(day);
    }
    return { every, days: WEEKDAYS.filter((d) => named.includes(d)), basis: requireBasis(value) };
  }
  if (every === 'month') {
    requireKeys(value, ['every', 'day', 'basis']);
    return { every, day: requireInteger(value, 'day', 1, 31), basis: requireBasis(value) };
  }
  throw new RecurrenceError('recurrence.every must be "days", "weekdays", "week" or "month"');
}

/** The stored form: `tasks.recurrence` holds exactly this string. */
export function serialiseRecurrence(rule: Recurrence): string {
  return JSON.stringify(parseRecurrence(rule));
}

/** Read a stored rule back. A row that fails this was not written by this code. */
export function deserialiseRecurrence(stored: string): Recurrence {
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    throw new RecurrenceError('stored recurrence is not JSON');
  }
  return parseRecurrence(raw);
}

// ─── The next occurrence ────────────────────────────────────────────────────

/** Day N of a month, or the month's last day when it has no day N. */
function clampedDay(year: number, month: number, day: number): number {
  return daysFromCivil(year, month, Math.min(day, daysInMonth(year, month)));
}

/**
 * When the series next falls.
 *
 * `anchor` is where the count starts — the previous due date, or the day the
 * task was done — as a date or a full timestamp. Only its first ten characters
 * take part; whatever follows them (a time, an offset) is carried onto the
 * result unchanged. `today` is the calendar date where the person is standing.
 *
 * Two promises, both property-tested:
 *
 *   never a backlog   the result is strictly after `today`. A weekly task
 *                     finished three weeks late yields next week, once — not
 *                     three rows to tick through.
 *   never backwards   the result is strictly after `anchor`, so applying it
 *                     again always moves on.
 *
 * "Every N days" keeps its phase: the result is the anchor plus a whole number
 * of intervals. The other three rules name days outright, so they take the
 * first named day after both.
 */
export function nextOccurrence(rule: Recurrence, anchor: string, today: string): string {
  const from = dayNumber(anchor.slice(0, 10));
  const now = dayNumber(today);
  const suffix = anchor.slice(10);

  if (rule.every === 'days') {
    const steps = now < from ? 1 : Math.floor((now - from) / rule.interval) + 1;
    return dateOfDayNumber(from + steps * rule.interval) + suffix;
  }

  const earliest = Math.max(from, now) + 1;

  if (rule.every === 'month') {
    const start = civilFromDays(earliest);
    const thisMonth = clampedDay(start.year, start.month, rule.day);
    if (thisMonth >= earliest) return dateOfDayNumber(thisMonth) + suffix;
    const nextYear = start.month === 12 ? start.year + 1 : start.year;
    const nextMonth = start.month === 12 ? 1 : start.month + 1;
    return dateOfDayNumber(clampedDay(nextYear, nextMonth, rule.day)) + suffix;
  }

  const wanted: readonly Weekday[] =
    rule.every === 'weekdays' ? ['mon', 'tue', 'wed', 'thu', 'fri'] : rule.days;
  for (let offset = 0; offset < 7; offset++) {
    if (wanted.includes(weekdayOf(earliest + offset))) {
      return dateOfDayNumber(earliest + offset) + suffix;
    }
  }
  // Unreachable for a parsed rule: `days` is never empty, and any seven
  // consecutive days hold every weekday.
  throw new RecurrenceError('recurrence names no weekday');
}

// ─── In words ───────────────────────────────────────────────────────────────

const DAY_NAMES: Readonly<Record<Weekday, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The rule as the badge says it: "Every Tuesday", "Every 5 days after done",
 * "Monthly on the 31st". The basis is only spoken when it is `completed` — a
 * rule that counts from its due date is what "every Tuesday" already means.
 */
export function describeRecurrence(rule: Recurrence): string {
  const tail = rule.basis === 'completed' ? ' after done' : '';
  if (rule.every === 'days') {
    return (rule.interval === 1 ? 'Every day' : `Every ${rule.interval} days`) + tail;
  }
  if (rule.every === 'weekdays') return `Every weekday${tail}`;
  if (rule.every === 'month') return `Monthly on the ${ordinal(rule.day)}${tail}`;
  if (rule.days.length === 7) return `Every day${tail}`;
  return `Every ${joinWords(rule.days.map((d) => DAY_NAMES[d]))}${tail}`;
}

/**
 * The rule a person lands on when they pick a kind from the editor, before
 * they have said anything else. It reads the date the task is due (or today):
 * choosing "weekly" on a task due on a Tuesday means Tuesdays.
 */
export function defaultRecurrence(kind: RecurrenceKind, hintDate: string): Recurrence {
  const hint = dayNumber(hintDate.slice(0, 10));
  if (kind === 'days') return { every: 'days', interval: 1, basis: 'due' };
  if (kind === 'weekdays') return { every: 'weekdays', basis: 'due' };
  if (kind === 'week') return { every: 'week', days: [weekdayOf(hint)], basis: 'due' };
  return { every: 'month', day: civilFromDays(hint).day, basis: 'due' };
}
