import { hhmm, romeParts } from '../lib/rome.js';
import type { DepartureStatus, Entry, Reminder } from '../types.js';
import { astralDepartures, upcoming } from './astral.js';
import { upcomingArrivals } from './atac.js';
import { isDelayReliable, isValidCode, transits, type Transit } from './cotral.js';

/**
 * Port of ReminderDepartureStatus.swift (Madovai-Web's DepartureStatus.php): "what is the next departure" for the
 * three reminder sources, normalised to {time, delayMinutes, isCancelled, nextUsefulTime}.
 * `nextUsefulTime` ("prossimo utile") is the following departure's time, set only when the first one is cancelled.
 */

interface Item { time: string; delayMinutes: number | null; isCancelled: boolean }

/** null = failure / nothing upcoming (the reminder runner retries later, no notification). Never throws. */
export async function departureStatus(reminder: Reminder, now: Date = new Date()): Promise<DepartureStatus | null> {
  try {
    const source = (reminder as Partial<Reminder> | null)?.source as Record<string, unknown> | undefined;
    if (!source || typeof source !== 'object') return null;
    switch (source.type) {
      case 'cotralBus': {
        const result = await transits(String(source.poleCode ?? ''));
        return result === null ? null : fromTransits(result.transits, now);
      }
      case 'cotralTrain': {
        const direction = await astralDepartures(String(source.route ?? ''), String(source.stationName ?? ''));
        if (direction === null) return null;
        return fromAstral(upcoming(direction.entries, romeParts(now).secondsSinceMidnight));
      }
      case 'atacStop': {
        const stopId = String(source.stopId ?? '');
        if (!isValidCode(stopId)) return null;
        return fromAtac(await upcomingArrivals(stopId, 2, Math.floor(now.getTime() / 1000)));
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

type TransitLike = Pick<Transit, 'tempoTransito' | 'orarioPartenzaCorsa' | 'ritardoSeconds' | 'monitorata' | 'vehicleAlive' | 'soppressa'>;

/** Cotral bus: next not-yet-passed runs, delay-aware (Transit.minutesFromNow / adjustedDisplayTime). */
export function fromTransits(list: TransitLike[], now: Date = new Date()): DepartureStatus | null {
  const p = romeParts(now);
  const nowMinutes = p.hour * 60 + p.minute;
  const items: (Item & { minutes: number; index: number })[] = [];
  list.forEach((t, index) => {
    const reliable = isDelayReliable(t);
    const display = t.tempoTransito !== '' ? t.tempoTransito : t.orarioPartenzaCorsa;
    const adjusted = reliable && Math.abs(t.ritardoSeconds) >= 60 ? applyingDelay(display, t.ritardoSeconds) : display;
    const minutes = minutesFromNow(adjusted, nowMinutes);
    if (minutes === null || minutes < 0) return;
    items.push({
      minutes,
      index,
      time: adjusted,
      // truncates toward zero like Swift's `/`
      delayMinutes: reliable ? Math.max(0, Math.trunc(t.ritardoSeconds / 60)) : null,
      isCancelled: String(t.soppressa).replace(/^[ \t]+|[ \t]+$/g, '').toUpperCase() === 'Y',
    });
  });
  items.sort((a, b) => a.minutes - b.minutes || a.index - b.index);
  return combine(items);
}

/** ASTRAL: `upcoming` already sorted. */
export function fromAstral(list: Entry[]): DepartureStatus | null {
  return combine(list.map((d) => ({
    time: d.time,
    delayMinutes: d.delayMinutes === null ? null : Math.max(0, d.delayMinutes),
    isCancelled: d.isCancelled,
  })));
}

/** Atac: arrivals sorted soonest first. */
export function fromAtac(arrivals: { ts: number; delaySeconds: number | null; isCancelled: boolean }[]): DepartureStatus | null {
  return combine(arrivals.map((a) => ({
    time: hhmm(a.ts),
    delayMinutes: a.delaySeconds === null ? null : Math.max(0, Math.trunc(a.delaySeconds / 60)),
    isCancelled: a.isCancelled,
  })));
}

function combine(entries: Item[]): DepartureStatus | null {
  if (entries.length === 0) return null;
  const first = entries[0];
  return {
    time: first.time,
    delayMinutes: first.delayMinutes,
    isCancelled: first.isCancelled,
    nextUsefulTime: first.isCancelled ? (entries[1]?.time ?? null) : null,
  };
}

/** "HH:MM" + seconds, wrapped to a 24h clock face (double modulo handles negatives). */
function applyingDelay(time: string, ritardoSeconds: number): string {
  const m = /^(\d+):(\d+)$/.exec(time);
  if (!m) return time;
  const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + ritardoSeconds;
  const wrapped = ((total % 86400) + 86400) % 86400;
  return `${String(Math.floor(wrapped / 3600)).padStart(2, '0')}:${String(Math.floor((wrapped % 3600) / 60)).padStart(2, '0')}`;
}

/** Transit.minutesFromNow(): single day wrap around ±12 h. */
function minutesFromNow(time: string, nowMinutes: number): number | null {
  const m = /^(\d+):(\d+)$/.exec(time);
  if (!m) return null;
  let diff = Number(m[1]) * 60 + Number(m[2]) - nowMinutes;
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;
  return diff;
}
