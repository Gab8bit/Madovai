import type Database from 'better-sqlite3';
import { gtfs } from '../db.js';
import { BadRequest } from '../lib/errors.js';
import { romeParts } from '../lib/rome.js';
import type { Entry } from '../types.js';
import { entry, indexFor, parseQuery, SearchIndex } from './search.js';
import { extractLocality, kindName, metroName, phpCompareStrings, phpFloatStr, strcmp, trimWs, type KindName } from './text.js';

/**
 * Read access to madovai.sqlite — port of Madovai-Web's src/Gtfs/Store.php (itself a port of the iOS GTFSStore /
 * AtacGtfsStore / PolesRepository queries). Same SQL, same ordering, same limits, same JSON shapes.
 * Every user-supplied value goes through bound parameters.
 */

export interface RouteJson {
  source: 'cotral' | 'atac';
  id: string;
  shortName: string;
  longName: string;
  displayName: string;
  kind: KindName;
  operator: string;
  color: string | null;
  rail: boolean;
}

export interface StopJson {
  source: 'cotral' | 'atac';
  id: string;
  name: string;
  lat: number;
  lon: number;
  rail: boolean;
  metro?: boolean;
}

export interface StopWithHeadsign { id: string; name: string; lat: number; lon: number; headsign: string | null }
/** Representative trip of one direction of a line: its stops in sequence order (optional field of /line). */
export interface LineDirection { directionId: number; headsign: string | null; stopIds: string[] }
export interface ShapeJson { id: string; coords: string; bbox: [number, number, number, number] }
export interface RegionShapeJson extends ShapeJson { routeId: string; kind: KindName; color: string | null }
export interface Direction { destination: string; route: string | null; entries: Entry[] }
export interface Pole { id: string; name: string; locality: string; lat: number; lon: number; rail: boolean; trainRoutes: string[] }
export interface ScheduledDeparture { tripId: string; routeId: string; routeLabel: string; kind: KindName; ts: number; headsign: string | null }

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => Number(v ?? 0);

// ------------------------------------------------------------------ Rome time helpers

/** Rome wall-clock facts of an instant, as Store.php derives them from a DateTimeImmutable in Europe/Rome. */
export function romeNow(now: Date = new Date()) {
  const p = romeParts(now);
  // Real Rome midnight (DateTimeImmutable::setTime(0,0,0)->getTimestamp()): UTC midnight of the Rome date minus
  // the UTC offset in force at that midnight (DST changes happen at 02:00/03:00, never at midnight).
  const utcMidnight = Date.UTC(p.year, p.month - 1, p.day) / 1000;
  const offsetAt = (unix: number) => {
    const q = romeParts(new Date(unix * 1000));
    return Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) / 1000 - unix;
  };
  let midnight = utcMidnight - offsetAt(utcMidnight);
  midnight = utcMidnight - offsetAt(midnight);
  return {
    ymd: p.ymd,
    secondsSinceMidnight: p.secondsSinceMidnight,
    /** ISO-8601 weekday: 1 = Monday … 7 = Sunday (PHP format('N')). */
    isoWeekday: p.weekday === 1 ? 7 : p.weekday - 1,
    midnightUnix: midnight,
  };
}

export class Store {
  constructor(private readonly db: Database.Database) {}

  static open(): Store {
    return new Store(gtfs());
  }

  // ------------------------------------------------------------------ mapping helpers

  static cotralRoute(r: Row): RouteJson {
    const rail = num(r.is_rail) === 1;
    return {
      source: 'cotral',
      id: str(r.route_id),
      shortName: str(r.short_name),
      longName: str(r.long_name),
      displayName: str(r.short_name),
      kind: rail ? 'treno' : 'bus',
      operator: 'Cotral',
      color: null,
      rail,
    };
  }

  static atacRoute(r: Row): RouteJson {
    const short = str(r.short_name);
    const long = str(r.long_name);
    const color = str(r.color);
    return {
      source: 'atac',
      id: str(r.route_id),
      shortName: short,
      longName: long,
      displayName: metroName(short) ?? (long === '' ? short : long),
      kind: kindName(Math.trunc(num(r.kind))),
      operator: str(r.operator),
      color: color === '' ? null : color,
      rail: false,
    };
  }

  private static cotralStop(r: Row): StopJson {
    return { source: 'cotral', id: str(r.stop_id), name: str(r.name), lat: num(r.lat), lon: num(r.lon), rail: num(r.is_rail) === 1 };
  }

  private static atacStopRow(r: Row): StopJson {
    return { source: 'atac', id: str(r.stop_id), name: str(r.name), lat: num(r.lat), lon: num(r.lon), rail: false };
  }

  private static stopWithHeadsign(r: Row): StopWithHeadsign {
    const h = r.headsign;
    return {
      id: str(r.stop_id),
      name: str(r.name),
      lat: num(r.lat),
      lon: num(r.lon),
      headsign: h === null || h === undefined || h === '' ? null : String(h),
    };
  }

  private static shapeRows(rows: Row[]): ShapeJson[] {
    return rows.map((r) => ({
      id: str(r.shape_id),
      coords: str(r.polyline),
      bbox: [num(r.min_lat), num(r.min_lon), num(r.max_lat), num(r.max_lon)],
    }));
  }

  // ------------------------------------------------------------------ stops

  /**
   * Stops inside the bbox, nearest to its centre first (iOS returned the first N in file order).
   * Bounds are bound as text with PHP's float formatting, exactly as the PHP endpoint did (identical ordering).
   */
  stopsInBox(minLat: number, minLon: number, maxLat: number, maxLon: number, cotralLimit: number, atacLimit: number) {
    const cLat = (minLat + maxLat) / 2;
    const cLon = (minLon + maxLon) / 2;
    // Equirectangular distance (a degree of longitude is shorter than one of latitude).
    const k = Math.cos((cLat / 180) * Math.PI) ** 2;
    const dist = '((lat - :cLat) * (lat - :cLat) + (lon - :cLon) * (lon - :cLon) * :k)';
    const params = {
      minLat: phpFloatStr(minLat), minLon: phpFloatStr(minLon), maxLat: phpFloatStr(maxLat), maxLon: phpFloatStr(maxLon),
      cLat: phpFloatStr(cLat), cLon: phpFloatStr(cLon), k: phpFloatStr(k),
    };
    const cotral = (this.db.prepare(
      `SELECT stop_id, name, lat, lon, is_rail FROM cotral_stops
       WHERE lat BETWEEN :minLat AND :maxLat AND lon BETWEEN :minLon AND :maxLon
       ORDER BY ${dist}, stop_id LIMIT :lim`,
    ).all({ ...params, lim: cotralLimit }) as Row[]).map((r) => {
      const name = str(r.name);
      return { id: str(r.stop_id), name, locality: extractLocality(name), lat: num(r.lat), lon: num(r.lon), rail: num(r.is_rail) === 1 };
    });
    const atac = (this.db.prepare(
      `SELECT stop_id, name, lat, lon FROM atac_stops
       WHERE lat BETWEEN :minLat AND :maxLat AND lon BETWEEN :minLon AND :maxLon
       ORDER BY ${dist}, stop_id LIMIT :lim`,
    ).all({ ...params, lim: atacLimit }) as Row[]).map((r) => ({ id: str(r.stop_id), name: str(r.name), lat: num(r.lat), lon: num(r.lon) }));
    return { cotral, atac };
  }

  // ------------------------------------------------------------------ search

  /**
   * Stops (Cotral max 15 + Atac max 15) and lines (Cotral max 10 + Atac max 10) matching every word of the query,
   * best matches first (see search.ts). Lines match on shortName, longName and displayName ("Metro A").
   */
  search(query: string): { stops: StopJson[]; routes: RouteJson[] } {
    const q = parseQuery(query);
    if (q === null) return { stops: [], routes: [] };
    return this.searchIndex().search(q);
  }

  /** Every stop and line name, normalized once per database file (the JSON rows are prebuilt too). */
  private searchIndex(): SearchIndex<StopJson, RouteJson> {
    return indexFor(this.db, 'search', () => {
      const cotralStops = (this.db.prepare('SELECT stop_id, name, lat, lon, is_rail FROM cotral_stops ORDER BY rowid').all() as Row[])
        .map((r, i) => entry([str(r.name)], i, Store.cotralStop(r)));
      const metro = new Set((this.db.prepare(
        `SELECT DISTINCT stop_id FROM atac_stop_routes WHERE route_id IN (${Store.METRO_ROUTE_IDS.map(() => '?').join(',')})`,
      ).pluck().all(...Store.METRO_ROUTE_IDS) as unknown[]).map(str));
      const atacStops = (this.db.prepare('SELECT stop_id, name, lat, lon FROM atac_stops ORDER BY rowid').all() as Row[]).map((r, i) => {
        const row = Store.atacStopRow(r);
        row.metro = metro.has(row.id);
        return entry([row.name], i, row);
      });
      const routes = (sql: string, map: (r: Row) => RouteJson) => (this.db.prepare(sql).all() as Row[]).map((r, i) => {
        const route = map(r);
        return entry([route.shortName, route.longName, route.displayName], i, route);
      });
      return new SearchIndex(
        cotralStops,
        atacStops,
        routes('SELECT * FROM cotral_routes ORDER BY short_name, route_id', Store.cotralRoute),
        routes('SELECT * FROM atac_routes ORDER BY short_name, route_id', Store.atacRoute),
      );
    });
  }

  /** Builds the search index now (after startup / a rebuild) instead of on the first search. */
  warmSearch(): void {
    this.searchIndex();
  }

  /** Whether the database has `table` (an older schema may not; cached per database file). */
  private hasTable(table: string): boolean {
    const tables = indexFor(this.db, 'tables', () => new Map<string, boolean>());
    let v = tables.get(table);
    if (v === undefined) {
      v = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
      tables.set(table, v);
    }
    return v;
  }

  /** Route ids of Rome's metro lines (ReminderFormView.metroStopIds). */
  static readonly METRO_ROUTE_IDS = ['MEA', 'MEB', 'MEB1', 'MEC'];

  /** Which of `stopIds` are served by at least one metro route — one query for the whole batch. */
  metroStopIds(stopIds: string[]): Set<string> {
    if (stopIds.length === 0) return new Set();
    const inStops = stopIds.map(() => '?').join(',');
    const inRoutes = Store.METRO_ROUTE_IDS.map(() => '?').join(',');
    const ids = this.db.prepare(`SELECT DISTINCT stop_id FROM atac_stop_routes WHERE route_id IN (${inRoutes}) AND stop_id IN (${inStops})`)
      .pluck().all(...Store.METRO_ROUTE_IDS, ...stopIds) as unknown[];
    return new Set(ids.map(str));
  }

  // ------------------------------------------------------------------ lines / line

  lines(): { atac: RouteJson[]; cotralRail: RouteJson[] } {
    const atac = (this.db.prepare('SELECT * FROM atac_routes ORDER BY short_name, route_id').all() as Row[]).map(Store.atacRoute);
    const cotralRail = (this.db.prepare('SELECT * FROM cotral_routes WHERE is_rail = 1 ORDER BY short_name, route_id').all() as Row[]).map(Store.cotralRoute);
    return { atac, cotralRail };
  }

  line(source: string, id: string): { route: RouteJson; stops: StopWithHeadsign[]; shapes: ShapeJson[]; directions?: LineDirection[] } {
    if (source === 'atac') {
      const row = this.db.prepare('SELECT * FROM atac_routes WHERE route_id = ?').get(id) as Row | undefined;
      if (!row) throw new BadRequest('Linea inesistente');
      const ordered = this.hasTable('atac_route_stops');
      // Route order (schema 2); a database built by an older version keeps the old alphabetical list until rebuilt.
      const stops = (this.db.prepare(ordered
        ? `SELECT s.stop_id, s.name, s.lat, s.lon, h.headsign
           FROM atac_route_stops o
           JOIN atac_stops s ON s.stop_id = o.stop_id
           LEFT JOIN atac_stop_headsign h ON h.route_id = o.route_id AND h.stop_id = o.stop_id
           WHERE o.route_id = ? ORDER BY o.pos`
        : `SELECT s.stop_id, s.name, s.lat, s.lon, h.headsign
           FROM atac_stop_routes sr
           JOIN atac_stops s ON s.stop_id = sr.stop_id
           LEFT JOIN atac_stop_headsign h ON h.route_id = sr.route_id AND h.stop_id = sr.stop_id
           WHERE sr.route_id = ? ORDER BY s.name, s.stop_id`,
      ).all(id) as Row[]).map(Store.stopWithHeadsign);
      const shapes = this.db.prepare('SELECT shape_id, polyline, min_lat, min_lon, max_lat, max_lon FROM atac_shapes WHERE route_id = ? ORDER BY rowid').all(id) as Row[];
      const out: ReturnType<Store['line']> = { route: Store.atacRoute(row), stops, shapes: Store.shapeRows(shapes) };
      if (ordered) out.directions = this.lineDirections('atac', id, stops);
      return out;
    }
    if (source !== 'cotral') throw new BadRequest("Parametro 'source' non valido");

    const row = this.db.prepare('SELECT * FROM cotral_routes WHERE route_id = ?').get(id) as Row | undefined;
    if (!row) throw new BadRequest('Linea inesistente');
    const route = Store.cotralRoute(row);
    if (route.rail) {
      const stops = this.railStopsInOrder(id).map(Store.stopWithHeadsign);
      const shapes = Store.shapeRows(this.db.prepare(
        'SELECT shape_id, polyline, min_lat, min_lon, max_lat, max_lon FROM cotral_rail_shapes WHERE route_id = ? ORDER BY rowid',
      ).all(id) as Row[]);
      return { route, stops, shapes };
    }
    const ordered = this.hasTable('cotral_route_stops');
    const stops = (this.db.prepare(ordered
      ? `SELECT s.stop_id, s.name, s.lat, s.lon FROM cotral_route_stops o
         JOIN cotral_stops s ON s.stop_id = o.stop_id WHERE o.route_id = ? ORDER BY o.pos`
      : `SELECT s.stop_id, s.name, s.lat, s.lon FROM cotral_stop_routes sr
         JOIN cotral_stops s ON s.stop_id = sr.stop_id WHERE sr.route_id = ? ORDER BY s.stop_id`,
    ).all(id) as Row[]).map(Store.stopWithHeadsign);
    const out: ReturnType<Store['line']> = { route, stops, shapes: [] };
    if (ordered) out.directions = this.lineDirections('cotral', id, stops);
    return out;
  }

  /** The representative trip of each direction (stops not in `stops`, i.e. missing from stops.txt, are left out). */
  private lineDirections(prefix: 'atac' | 'cotral', routeId: string, stops: StopWithHeadsign[]): LineDirection[] {
    const known = new Set(stops.map((s) => s.id));
    return (this.db.prepare(`SELECT direction_id, headsign, stop_ids FROM ${prefix}_route_directions WHERE route_id = ? ORDER BY direction_id`)
      .all(routeId) as Row[]).map((r) => ({
      directionId: Math.trunc(num(r.direction_id)),
      headsign: r.headsign === null || r.headsign === '' ? null : str(r.headsign),
      stopIds: (JSON.parse(str(r.stop_ids)) as string[]).filter((sid) => known.has(sid)),
    }));
  }

  /**
   * Port of GTFSStore.stopsForRouteInOrder: the longest trip of the route (ties: lowest trip_id), its stations in
   * stop_sequence order (stations missing from stops.txt are skipped).
   */
  railStopsInOrder(routeId: string): Row[] {
    const trip = this.db.prepare(
      `SELECT t.trip_id FROM rail_trips t JOIN rail_stop_times s ON s.trip_id = t.trip_id
       WHERE t.route_id = ? GROUP BY t.trip_id ORDER BY COUNT(*) DESC, t.trip_id ASC LIMIT 1`,
    ).pluck().get(routeId) as string | undefined;
    if (trip === undefined) {
      return this.db.prepare(
        `SELECT s.stop_id, s.name, s.lat, s.lon FROM cotral_stop_routes sr
         JOIN cotral_stops s ON s.stop_id = sr.stop_id WHERE sr.route_id = ? ORDER BY s.stop_id`,
      ).all(routeId) as Row[];
    }
    return this.db.prepare(
      `SELECT s.stop_id, s.name, s.lat, s.lon FROM rail_stop_times x
       JOIN cotral_stops s ON s.stop_id = x.stop_id WHERE x.trip_id = ? ORDER BY x.seq`,
    ).all(trip) as Row[];
  }

  // ------------------------------------------------------------------ shapes

  /** Atac shapes whose bbox intersects the box (port of shapesInRegion), in rowid order, max `limit`. */
  shapesInBox(minLat: number, minLon: number, maxLat: number, maxLon: number, limit: number): RegionShapeJson[] {
    const rows = this.db.prepare(
      `SELECT s.shape_id, s.route_id, s.polyline, s.min_lat, s.min_lon, s.max_lat, s.max_lon, r.kind, r.color
       FROM atac_shapes s LEFT JOIN atac_routes r ON r.route_id = s.route_id
       WHERE s.min_lat <= :maxLat AND s.max_lat >= :minLat AND s.min_lon <= :maxLon AND s.max_lon >= :minLon
       ORDER BY s.rowid LIMIT :lim`,
    ).all({
      minLat: phpFloatStr(minLat), minLon: phpFloatStr(minLon), maxLat: phpFloatStr(maxLat), maxLon: phpFloatStr(maxLon), lim: limit,
    }) as Row[];
    return rows.map((r) => {
      const color = str(r.color);
      return {
        id: str(r.shape_id),
        routeId: str(r.route_id),
        kind: kindName(r.kind === null ? 3 : Math.trunc(num(r.kind))),
        color: color === '' ? null : color,
        coords: str(r.polyline),
        bbox: [num(r.min_lat), num(r.min_lon), num(r.max_lat), num(r.max_lon)] as [number, number, number, number],
      };
    });
  }

  // ------------------------------------------------------------------ atac-stop / atac-schedule

  /** Every platform sharing the (trimmed) name of `stopId` (AtacGtfsStore.stopsSharingName), by stop_id. */
  atacStopGroup(stopId: string, routeId: string | null): { name: string; stops: StopWithHeadsign[] } {
    const raw = this.db.prepare('SELECT name FROM atac_stops WHERE stop_id = ?').pluck().get(stopId);
    if (raw === undefined) throw new BadRequest('Fermata inesistente');
    const name = trimWs(str(raw));
    const rows = this.db.prepare("SELECT stop_id, name, lat, lon FROM atac_stops WHERE trim(name, ' ' || char(9)) = :n ORDER BY stop_id").all({ n: name }) as Row[];
    const byRoute = this.db.prepare('SELECT headsign FROM atac_stop_headsign WHERE route_id = ? AND stop_id = ?').pluck();
    const any = this.db.prepare('SELECT headsign FROM atac_stop_headsign WHERE stop_id = ? ORDER BY route_id LIMIT 1').pluck();
    const stops = rows.map((r) => {
      const h = routeId !== null ? byRoute.get(routeId, r.stop_id) : any.get(r.stop_id);
      return Store.stopWithHeadsign({ ...r, headsign: h === undefined ? null : h });
    });
    return { name, stops };
  }

  /**
   * Static-timetable fallback (AtacGtfsStore.scheduledDepartures): today's active services (Rome) x departures
   * >= now, 6 soonest. Like iOS, a night run still under yesterday's service_id is not covered.
   */
  atacScheduled(stopId: string, now: Date = new Date(), limit = 6): ScheduledDeparture[] {
    const t = romeNow(now);
    const rows = this.db.prepare(
      `SELECT t.trip_id, t.route_id, x.dep_secs, r.short_name, r.kind, h.headsign
       FROM atac_stop_times x
       JOIN atac_trips t ON t.rowid = x.trip_rid
       LEFT JOIN atac_routes r ON r.route_id = t.route_id
       LEFT JOIN atac_stop_headsign h ON h.route_id = t.route_id AND h.stop_id = x.stop_id
       WHERE x.stop_id = :stop AND x.dep_secs >= :now
         AND t.service_id IN (SELECT service_id FROM atac_service_dates WHERE date = :date)
       ORDER BY x.dep_secs, x.trip_rid LIMIT :lim`,
    ).all({ stop: stopId, now: t.secondsSinceMidnight, date: t.ymd, lim: limit }) as Row[];
    return rows.map((r) => ({
      tripId: str(r.trip_id),
      routeId: str(r.route_id),
      routeLabel: r.short_name !== null ? str(r.short_name) : str(r.route_id),
      kind: kindName(r.kind === null ? 3 : Math.trunc(num(r.kind))),
      ts: t.midnightUnix + num(r.dep_secs),
      headsign: r.headsign === null || r.headsign === '' ? null : str(r.headsign),
    }));
  }

  // ------------------------------------------------------------------ pole / rail

  private static readonly RAIL_LINE_ORDER = ['ROMALIDO', 'RVURB', 'RVEXT'];

  /** `CotralTrainRoute.directions(forGTFSRouteShortName:)`: ASTRAL direction codes per rail line. */
  static trainDirections(routeShortName: string): string[] | null {
    switch (routeShortName.toUpperCase()) {
      case 'ROMALIDO': return ['RL_CC-PSP', 'RL_PSP-CC'];
      case 'RVURB': return ['RN_RMMON', 'RN_MONRM'];
      case 'RVEXT': return ['RV_CATVIT', 'RV_VITCAT', 'RV_MORCAT', 'RV_CATMOR'];
      default: return null;
    }
  }

  /**
   * Candidate ASTRAL route codes for a stop: from the `F:` (rail) routes serving it, in a fixed line order
   * (a station shared by two lines tries both).
   */
  trainRoutesForStop(stopId: string): string[] {
    const shorts = (this.db.prepare(
      `SELECT r.short_name FROM cotral_stop_routes sr JOIN cotral_routes r ON r.route_id = sr.route_id
       WHERE sr.stop_id = ? AND r.is_rail = 1`,
    ).pluck().all(stopId) as unknown[]).map((s) => str(s).toUpperCase());
    const codes: string[] = [];
    for (const line of Store.RAIL_LINE_ORDER) {
      if (shorts.includes(line)) codes.push(...(Store.trainDirections(line) ?? []));
    }
    return codes;
  }

  pole(stopId: string): Pole | null {
    const r = this.db.prepare('SELECT stop_id, name, locality, lat, lon, is_rail FROM cotral_stops WHERE stop_id = ?').get(stopId) as Row | undefined;
    if (!r) return null;
    return {
      id: str(r.stop_id),
      name: str(r.name),
      locality: str(r.locality),
      lat: num(r.lat),
      lon: num(r.lon),
      rail: num(r.is_rail) === 1,
      trainRoutes: this.trainRoutesForStop(stopId),
    };
  }

  /** service_ids active on the Rome date of `now` (calendar weekday pattern, calendar_dates override). */
  railActiveServices(now: Date = new Date()): string[] {
    const t = romeNow(now);
    const col = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][t.isoWeekday - 1];
    const override = new Map<string, boolean>();
    for (const r of this.db.prepare('SELECT service_id, added FROM rail_calendar_dates WHERE date = ?').all(t.ymd) as Row[]) {
      override.set(str(r.service_id), num(r.added) === 1);
    }
    const active = new Set<string>(
      (this.db.prepare(`SELECT service_id FROM rail_calendar WHERE start_date <= :d AND end_date >= :d AND ${col} = 1`).pluck().all({ d: t.ymd }) as unknown[]).map(str),
    );
    for (const [sid, added] of override) {
      if (added) active.add(sid);
      else active.delete(sid);
    }
    return [...active];
  }

  /**
   * Port of GTFSStore.scheduledDepartures(forRailStopId:) + PoleDetailViewModel.gtfsScheduledDirections: the whole
   * day's trips calling at the stop, grouped by destination station name, each group sorted by time.
   */
  railScheduledDirections(stopId: string, now: Date = new Date()): Direction[] {
    const services = this.railActiveServices(now);
    if (services.length === 0) return [];
    const inList = services.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT x.trip_id, MIN(x.seq) AS seq, x.dep_secs,
              (SELECT d.name FROM rail_stop_times l JOIN cotral_stops d ON d.stop_id = l.stop_id
               WHERE l.trip_id = x.trip_id AND l.seq = (SELECT MAX(seq) FROM rail_stop_times WHERE trip_id = x.trip_id)) AS dest
       FROM rail_stop_times x JOIN rail_trips t ON t.trip_id = x.trip_id
       WHERE x.stop_id = ? AND t.service_id IN (${inList})
       GROUP BY x.trip_id`,
    ).all(stopId, ...services) as Row[];
    const deps = rows
      .filter((r) => r.dest !== null) // destination station unknown: dropped, like iOS
      .map((r) => ({ tripId: str(r.trip_id), dest: str(r.dest), secs: Math.trunc(num(r.dep_secs)) }));
    deps.sort((a, b) => (a.secs !== b.secs ? a.secs - b.secs : phpCompareStrings(a.tripId, b.tripId)));

    const groups = new Map<string, Entry[]>();
    for (const d of deps) {
      let g = groups.get(d.dest);
      if (!g) groups.set(d.dest, (g = []));
      const hh = Math.floor(d.secs / 3600) % 24;
      const mm = Math.floor(d.secs / 60) % 60;
      g.push({
        id: d.tripId,
        time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
        sortSeconds: d.secs,
        delayMinutes: null,
        isCancelled: false,
        isReplacementBus: false,
      });
    }
    return sortDirections([...groups].map(([destination, entries]) => ({ destination, route: null, entries })));
  }
}

/** Directions sorted by destination name (byte-wise, like PHP strcmp; stable). */
export function sortDirections<T extends { destination: string }>(directions: T[]): T[] {
  return directions.sort((a, b) => strcmp(a.destination, b.destination));
}
