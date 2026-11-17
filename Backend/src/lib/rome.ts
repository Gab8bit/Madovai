/** Everything time-of-day is Rome wall-clock time, regardless of where the server or the client is. */
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});
const WEEKDAY: Record<string, number> = { Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7 };

export interface RomeParts {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
  /** Apple Calendar convention: 1 = Sunday … 7 = Saturday (same as Madovai reminders). */
  weekday: number;
  /** yyyymmdd as an int — the GTFS calendar date format. */
  ymd: number;
  secondsSinceMidnight: number;
}

export function romeParts(date: Date = new Date()): RomeParts {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  const year = +p.year, month = +p.month, day = +p.day, hour = +p.hour, minute = +p.minute, second = +p.second;
  return {
    year, month, day, hour, minute, second,
    weekday: WEEKDAY[p.weekday] ?? 1,
    ymd: year * 10000 + month * 100 + day,
    secondsSinceMidnight: hour * 3600 + minute * 60 + second,
  };
}

/** "HH:mm" in Rome time for a unix timestamp in seconds. */
export function hhmm(unixSeconds: number): string {
  const p = romeParts(new Date(unixSeconds * 1000));
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Unix seconds of Rome midnight for the given date (handles DST via a probe). */
export function romeMidnightUnix(date: Date = new Date()): number {
  const p = romeParts(date);
  return Math.round(date.getTime() / 1000) - p.secondsSinceMidnight;
}
