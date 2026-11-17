import { config } from '../config.js';
import { gtfs } from '../db.js';
import { cached } from '../lib/cache.js';
import { fetchBuffer } from '../lib/http.js';
import type { Kind, Operator } from '../types.js';
import { decodeTripUpdates, decodeVehicles, type StopEvent, type TripUpdatesIndex, type VehicleFeed } from './gtfsRealtime.js';

/**
 * Roma Mobilità GTFS-Realtime: vehicle_positions + trip_updates. Port of Madovai-Web's AtacRealtime.php +
 * AtacStatic.php (AtacRealtimeService / AtacStopArrivalClient on iOS).
 * The DECODED + indexed structures are cached (12 s, stale ≤ 120 s), not the raw bytes: N visitors cost one download
 * and one decode per feed. Enrichment from the static GTFS tables (atac_routes / atac_trips / atac_stops) uses batched
 * IN queries and degrades to raw ids when the database isn't built yet.
 */
export const TTL_MS = 12_000;
const STALE_MS = 120_000;
const FEED_TIMEOUT_MS = 12_000;
export const STOP_LIMIT = 150;

const nowSec = () => Math.floor(Date.now() / 1000);

// ---- static lookups (AtacStatic.php) -----------------------------------------------------------------------------

const CHUNK = 500;
const KINDS: Record<number, Kind> = { 3: 'bus', 0: 'tram', 1: 'metro', 2: 'treno' };

export interface RouteMeta { label: string; kind: Kind; operator: Operator }
export interface TripMeta { route: string | null; headsign: string | null }

function query(sqlTemplate: string, ids: Iterable<string>): Record<string, unknown>[] {
  const list = [...new Set([...ids].filter((i) => i !== '' && i != null).map(String))];
  if (list.length === 0) return [];
  try {
    const db = gtfs();
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const stmt = db.prepare(sqlTemplate.replace('%s', chunk.map(() => '?').join(',')));
      for (const row of stmt.all(...chunk) as Record<string, unknown>[]) rows.push(row);
    }
    return rows;
  } catch {
    // NotReady (no DB yet) or a missing table / SQLite error: live data still works with raw GTFS ids.
    return [];
  }
}

function operatorOf(op: string): Operator {
  switch (op) {
    case 'Atac': case 'Roma TPL': case 'Cotral': return op as Operator;
    case 'OP1': return 'Atac';
    default: return op === '' ? 'Atac' : 'Roma TPL';
  }
}

export function routesMeta(ids: Iterable<string>): Map<string, RouteMeta> {
  const out = new Map<string, RouteMeta>();
  for (const r of query('SELECT route_id, short_name, kind, operator FROM atac_routes WHERE route_id IN (%s)', ids)) {
    out.set(String(r.route_id), {
      label: r.short_name == null ? '' : String(r.short_name),
      kind: KINDS[Number(r.kind)] ?? 'bus',
      operator: operatorOf(r.operator == null ? '' : String(r.operator)),
    });
  }
  return out;
}

export function tripsMeta(ids: Iterable<string>): Map<string, TripMeta> {
  const out = new Map<string, TripMeta>();
  for (const r of query('SELECT trip_id, route_id, headsign FROM atac_trips WHERE trip_id IN (%s)', ids)) {
    const h = r.headsign == null ? '' : String(r.headsign);
    const route = r.route_id == null ? '' : String(r.route_id);
    out.set(String(r.trip_id), { route: route === '' ? null : route, headsign: h === '' ? null : h });
  }
  return out;
}

export function stopNames(ids: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of query('SELECT stop_id, name FROM atac_stops WHERE stop_id IN (%s)', ids)) {
    out.set(String(r.stop_id), String(r.name ?? ''));
  }
  return out;
}

const labelOr = (meta: RouteMeta | undefined, routeId: string) => (meta && meta.label !== '' ? meta.label : routeId);

// ---- feeds -------------------------------------------------------------------------------------------------------

/** Decoded trip_updates indexes (by stop, by trip), cached 12 s. */
export function tripUpdates(): Promise<TripUpdatesIndex> {
  return cached('atac:tripupdates', TTL_MS, async () => {
    const buf = await fetchBuffer(config.upstream.atacTripUpdates, { timeoutMs: FEED_TIMEOUT_MS });
    return decodeTripUpdates(buf, nowSec());
  }, STALE_MS);
}

// ---- vehicles ----------------------------------------------------------------------------------------------------

export interface AtacVehicle {
  id: string;
  lat: number;
  lon: number;
  bearing: number | null;
  routeId: string | null;
  routeLabel: string | null;
  kind: Kind;
  operator: Operator;
  tripId: string | null;
  headsign: string | null;
}

export interface AtacVehicles { updated: number; vehicles: AtacVehicle[] }

/** PHP round() (half away from zero) to `places` decimals. */
function round(x: number, places: number): number {
  const f = 10 ** places;
  const r = Math.round(Math.abs(x) * f) / f;
  return x < 0 ? -r : r;
}

export function enrichVehicles(feed: VehicleFeed): AtacVehicles {
  const routeIds = new Set<string>();
  const tripIdSet = new Set<string>();
  for (const v of feed.vehicles) {
    if (v.routeId !== '') routeIds.add(v.routeId);
    if (v.tripId !== null && v.tripId !== '') tripIdSet.add(v.tripId);
  }
  const routes = routesMeta(routeIds);
  const trips = tripsMeta(tripIdSet); // one batched lookup (chunked IN lists)

  const vehicles = feed.vehicles.map((v): AtacVehicle => {
    const rid = v.routeId;
    const route = rid === '' ? undefined : routes.get(rid);
    return {
      id: `atac-${v.id}`,
      lat: round(v.lat, 6),
      lon: round(v.lon, 6),
      bearing: v.bearing === null ? null : round(v.bearing, 1),
      routeId: rid === '' ? null : rid,
      routeLabel: rid === '' ? null : labelOr(route, rid),
      kind: route?.kind ?? 'bus',
      operator: route?.operator ?? 'Atac',
      tripId: v.tripId,
      headsign: v.tripId === null ? null : (trips.get(v.tripId)?.headsign ?? null),
    };
  });
  return { updated: feed.timestamp > 0 ? feed.timestamp : nowSec(), vehicles };
}

/** All vehicles with a position, enriched; cached 12 s (decoded + enriched). */
export function atacVehicles(): Promise<AtacVehicles> {
  return cached('atac:vehicles', TTL_MS, async () => {
    const buf = await fetchBuffer(config.upstream.atacVehiclePositions, { timeoutMs: FEED_TIMEOUT_MS });
    return enrichVehicles(decodeVehicles(buf));
  }, STALE_MS);
}

// ---- stops -------------------------------------------------------------------------------------------------------

export interface StopArrival {
  tripId: string;
  routeId: string;
  routeLabel: string;
  kind: Kind;
  ts: number;
  delaySeconds: number | null;
  headsign: string | null;
  cancelled: boolean;
}

export interface StopArrivals { updated: number; stops: Record<string, StopArrival[]> }

function pick(entries: StopEvent[] | undefined, now: number): StopEvent[] {
  return (entries ?? []).filter((e) => e.ts - now > -120).sort((a, b) => a.ts - b.ts);
}

/**
 * Upcoming arrivals (arrival, else departure, with time > 0 and ts > now−120) for up to 150 stops, soonest first.
 * O(requested stops) on the cached index.
 */
export async function stopArrivals(stopIds: string[], now?: number): Promise<StopArrivals> {
  const ids = [...new Set(stopIds.map(String))].slice(0, STOP_LIMIT);
  const feed = await tripUpdates();
  const t = now ?? nowSec();

  const picked = new Map<string, StopEvent[]>();
  const routeIds = new Set<string>();
  const tripIdSet = new Set<string>();
  for (const sid of ids) {
    const list = pick(feed.byStop.get(sid), t);
    picked.set(sid, list);
    for (const e of list) {
      if (e.routeId !== '') routeIds.add(e.routeId);
      tripIdSet.add(e.tripId);
    }
  }
  const routes = routesMeta(routeIds);
  const trips = tripsMeta(tripIdSet);

  const stops: Record<string, StopArrival[]> = Object.create(null);
  for (const sid of ids) {
    stops[sid] = (picked.get(sid) ?? []).map((e) => {
      const route = routes.get(e.routeId);
      return {
        tripId: e.tripId,
        routeId: e.routeId,
        routeLabel: labelOr(route, e.routeId),
        kind: route?.kind ?? 'bus',
        ts: e.ts,
        delaySeconds: e.delay,
        headsign: trips.get(e.tripId)?.headsign ?? null,
        cancelled: e.cancelled,
      };
    });
  }
  return { updated: feed.timestamp > 0 ? feed.timestamp : nowSec(), stops };
}

/** Next arrivals at one stop for the reminders: soonest first. */
export async function upcomingArrivals(stopId: string, limit = 2, now?: number): Promise<{ ts: number; delaySeconds: number | null; isCancelled: boolean }[]> {
  const feed = await tripUpdates();
  return pick(feed.byStop.get(stopId), now ?? nowSec())
    .slice(0, Math.max(0, limit))
    .map((e) => ({ ts: e.ts, delaySeconds: e.delay, isCancelled: e.cancelled }));
}

// ---- trips -------------------------------------------------------------------------------------------------------

export interface AtacTrip {
  tripId: string;
  routeId: string | null;
  routeLabel: string | null;
  headsign: string | null;
  stops: { stopId: string; stopName: string; sequence: number; ts: number; delaySeconds: number | null }[];
}

/** Full itinerary of one trip (past and future stops, by sequence), or the static skeleton with `stops: []`. */
export async function atacTrip(tripId: string): Promise<AtacTrip> {
  const feed = await tripUpdates();
  const entry = feed.byTrip.get(tripId);
  const meta = tripsMeta([tripId]).get(tripId);
  if (!entry) {
    const routeId = meta?.route ?? null;
    const route = routeId === null ? undefined : routesMeta([routeId]).get(routeId);
    return {
      tripId,
      routeId,
      routeLabel: routeId === null ? null : labelOr(route, routeId),
      headsign: meta?.headsign ?? null,
      stops: [],
    };
  }
  const stops = [...entry.stops].sort((a, b) => a.sequence - b.sequence); // stable
  const routeId = (entry.route === '' ? null : entry.route) ?? meta?.route ?? null;
  const route = routeId === null ? undefined : routesMeta([routeId]).get(routeId);
  const names = stopNames(stops.map((s) => s.stopId));
  return {
    tripId,
    routeId,
    routeLabel: routeId === null ? null : labelOr(route, routeId),
    headsign: meta?.headsign ?? null,
    stops: stops.map((s) => ({
      stopId: s.stopId,
      stopName: names.get(s.stopId) ?? s.stopId,
      sequence: s.sequence,
      ts: s.ts,
      delaySeconds: s.delay,
    })),
  };
}
