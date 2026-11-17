import { romeParts } from '../lib/rome.js';

/** Rome wall-clock facts about an instant, as the PHP code read them from a Europe/Rome DateTimeImmutable. */
export interface RomeNow {
  /** unix seconds */
  ts: number;
  /** yyyymmdd (PHP `format('Ymd')`) */
  ymd: number;
  /** 1 = Sunday … 7 = Saturday (PHP `format('w') + 1`) */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

export function romeNow(now: Date): RomeNow {
  const p = romeParts(now);
  return { ts: Math.floor(now.getTime() / 1000), ymd: p.ymd, weekday: p.weekday, hour: p.hour, minute: p.minute, second: p.second };
}

/**
 * Unix seconds of today's (Rome) HH:MM — PHP `$now->setTime($h, $m, 0)->getTimestamp()`, DST included:
 * a wall time that does not exist (spring forward) moves forward one hour, as PHP does.
 */
export function romeWallTs(now: Date, hour: number, minute: number): number {
  const p = romeParts(now);
  const midnightLike = Math.floor(now.getTime() / 1000) - p.secondsSinceMidnight;
  let t = midnightLike + hour * 3600 + minute * 60;
  // The offset at `now` may differ from the offset at the target time (DST change earlier/later today): correct it.
  const q = romeParts(new Date(t * 1000));
  const diff = hour * 60 + minute - (q.hour * 60 + q.minute);
  if (diff !== 0 && Math.abs(diff) <= 60) t += diff * 60;
  return t;
}
