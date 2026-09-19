/**
 * The calendar date where the person is standing, as `YYYY-MM-DD`.
 *
 * The api runs in UTC and the household does not: at 00:30 in Rome the UTC
 * date is still yesterday. A recurring task's next occurrence is "the first one
 * strictly after today", so the device says what today is when it completes one
 * (`client.completeTask(id, { today })`), and the server checks it is within a
 * day of its own.
 *
 * This is the one place the local-time `Date` getters belong. Everything that
 * does arithmetic on the result (`@eal/shared` recurrence.ts) works on the
 * string and never sees a `Date`.
 */
export function localDateToday(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
