/**
 * sqlite's `datetime('now')` produces strings of the form `YYYY-MM-DD HH:MM:SS`
 * (space-separated, no timezone). These helpers match that format on both directions.
 */

export function formatSqliteDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function parseSqliteDateTime(s: string): Date {
  return new Date(`${s.replace(' ', 'T')}Z`);
}
