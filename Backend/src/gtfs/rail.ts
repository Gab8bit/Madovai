import { BadRequest } from '../lib/errors.js';
import type { Entry } from '../types.js';
import { phpTrim } from './text.js';
import { sortDirections, type Direction, type Store } from './store.js';

/** ASTRAL source (`astralDepartures` of the live module): null when the station isn't on that route. */
export type AstralDeparturesFn = (route: string, stationName: string) =>
  Promise<{ destination: string; route?: string | null; entries: Entry[] } | null>;

export interface RailResult {
  source: 'astral' | 'gtfs' | 'none';
  directions: Direction[];
}

/**
 * Port of PoleDetailViewModel.refreshRailDepartures (Madovai-Web src/Gtfs/RailService.php): ASTRAL first (every
 * candidate direction of the stop's line, keeping those that resolve the station), the static GTFS timetable only
 * when ASTRAL resolved nothing. The ASTRAL source is injected (null = unavailable) so the tiers are testable alone.
 * Candidate directions are queried in parallel; the result keeps their order, as the sequential PHP loop did.
 */
export async function railDepartures(store: Store, stopId: string, astral: AstralDeparturesFn | null, now: Date = new Date()): Promise<RailResult> {
  const pole = store.pole(stopId);
  if (pole === null) throw new BadRequest('Fermata inesistente');
  const stationName = phpTrim(pole.name);
  if (pole.trainRoutes.length === 0 || stationName === '') return { source: 'none', directions: [] };

  const resolved: Direction[] = [];
  if (astral) {
    const settled = await Promise.allSettled(pole.trainRoutes.map((code) => astral(code, stationName)));
    settled.forEach((s, i) => {
      // `try?` in Swift: any failure just means "this direction didn't resolve".
      if (s.status !== 'fulfilled' || s.value === null || s.value === undefined) return;
      const d = s.value;
      const entries = [...(d.entries ?? [])].sort((a, b) => (a.sortSeconds ?? 0) - (b.sortSeconds ?? 0));
      resolved.push({
        destination: String(d.destination ?? ''),
        route: d.route !== null && d.route !== undefined ? String(d.route) : pole.trainRoutes[i],
        entries,
      });
    });
  }
  if (resolved.length > 0) return { source: 'astral', directions: sortDirections(resolved) };

  const fallback = store.railScheduledDirections(stopId, now);
  if (fallback.length > 0) return { source: 'gtfs', directions: fallback };
  return { source: 'none', directions: [] };
}
