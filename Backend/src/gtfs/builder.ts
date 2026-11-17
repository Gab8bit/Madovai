import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { FeedSource } from './feed.js';
import { encodePolyline } from './polyline.js';
import { orderRoute, TripStopCollector, type TripInfo } from './routeOrder.js';
import {
  cleanHeadsign, ctypeDigit, extractLocality, isIntString, isNumeric, lower, parseCsvLine, phpFloatStr, phpInt,
  phpRound, phpTrim, stripTrailingHashCode, timeToSeconds, trimWs,
} from './text.js';

/**
 * Builds madovai.sqlite from the three static GTFS feeds (Cotral bus, Cotral rail, Rome/Atac).
 * Port of Madovai-Web's src/Gtfs/Builder.php: SAME schema, rows, rowids and indexes (the live module and the PHP
 * site read this file too). The two huge stop_times.txt files are streamed line by line; only compact
 * trip -> route maps and the distinct (stop, route) pairs live in memory.
 *
 * Floats are bound as the text PHP's PDO would bind (precision 14) so the stored REALs are identical.
 */

export type Feeds = { bus: FeedSource; rail: FeedSource; atac: FeedSource };
export type BuildStats = Record<string, number | string>;
export type Logger = (msg: string) => void;

const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;

CREATE TABLE cotral_stops(
  stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lc TEXT NOT NULL, locality TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL, is_rail INTEGER NOT NULL);
CREATE TABLE cotral_routes(
  route_id TEXT PRIMARY KEY, short_name TEXT NOT NULL, long_name TEXT NOT NULL, is_rail INTEGER NOT NULL,
  short_lc TEXT NOT NULL, long_lc TEXT NOT NULL);
CREATE TABLE cotral_stop_routes(
  stop_id TEXT NOT NULL, route_id TEXT NOT NULL, PRIMARY KEY(stop_id, route_id)) WITHOUT ROWID;
CREATE TABLE cotral_rail_shapes(
  route_id TEXT NOT NULL, shape_id TEXT NOT NULL, polyline TEXT NOT NULL,
  min_lat REAL NOT NULL, min_lon REAL NOT NULL, max_lat REAL NOT NULL, max_lon REAL NOT NULL);
CREATE TABLE rail_trips(trip_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, service_id TEXT NOT NULL);
CREATE TABLE rail_stop_times(
  trip_id TEXT NOT NULL, seq INTEGER NOT NULL, stop_id TEXT NOT NULL, dep_secs INTEGER NOT NULL,
  PRIMARY KEY(trip_id, seq)) WITHOUT ROWID;
CREATE TABLE rail_calendar(
  service_id TEXT PRIMARY KEY, mon INTEGER NOT NULL, tue INTEGER NOT NULL, wed INTEGER NOT NULL, thu INTEGER NOT NULL,
  fri INTEGER NOT NULL, sat INTEGER NOT NULL, sun INTEGER NOT NULL, start_date INTEGER NOT NULL, end_date INTEGER NOT NULL);
CREATE TABLE rail_calendar_dates(
  service_id TEXT NOT NULL, date INTEGER NOT NULL, added INTEGER NOT NULL, PRIMARY KEY(service_id, date)) WITHOUT ROWID;

CREATE TABLE atac_stops(
  stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lc TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL);
CREATE TABLE atac_routes(
  route_id TEXT PRIMARY KEY, short_name TEXT NOT NULL, long_name TEXT NOT NULL, kind INTEGER NOT NULL,
  operator TEXT NOT NULL, color TEXT, short_lc TEXT NOT NULL, long_lc TEXT NOT NULL);
CREATE TABLE atac_shapes(
  route_id TEXT NOT NULL, shape_id TEXT NOT NULL, polyline TEXT NOT NULL,
  min_lat REAL NOT NULL, min_lon REAL NOT NULL, max_lat REAL NOT NULL, max_lon REAL NOT NULL);
CREATE TABLE atac_trips(trip_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, service_id TEXT, headsign TEXT);
CREATE TABLE atac_stop_routes(
  stop_id TEXT NOT NULL, route_id TEXT NOT NULL, PRIMARY KEY(stop_id, route_id)) WITHOUT ROWID;
CREATE TABLE atac_stop_headsign(
  route_id TEXT NOT NULL, stop_id TEXT NOT NULL, headsign TEXT NOT NULL, PRIMARY KEY(route_id, stop_id)) WITHOUT ROWID;
CREATE TABLE atac_service_dates(
  date INTEGER NOT NULL, service_id TEXT NOT NULL, PRIMARY KEY(date, service_id)) WITHOUT ROWID;
CREATE TABLE atac_stop_times_raw(stop_id TEXT NOT NULL, dep_secs INTEGER NOT NULL, trip_rid INTEGER NOT NULL);

-- Schema 2: stops of each line in route order (see routeOrder.ts) and the representative trip of each direction.
CREATE TABLE atac_route_stops(
  route_id TEXT NOT NULL, pos INTEGER NOT NULL, stop_id TEXT NOT NULL, PRIMARY KEY(route_id, pos)) WITHOUT ROWID;
CREATE TABLE atac_route_directions(
  route_id TEXT NOT NULL, direction_id INTEGER NOT NULL, headsign TEXT, stop_ids TEXT NOT NULL,
  PRIMARY KEY(route_id, direction_id)) WITHOUT ROWID;
CREATE TABLE cotral_route_stops(
  route_id TEXT NOT NULL, pos INTEGER NOT NULL, stop_id TEXT NOT NULL, PRIMARY KEY(route_id, pos)) WITHOUT ROWID;
CREATE TABLE cotral_route_directions(
  route_id TEXT NOT NULL, direction_id INTEGER NOT NULL, headsign TEXT, stop_ids TEXT NOT NULL,
  PRIMARY KEY(route_id, direction_id)) WITHOUT ROWID;
`;

/** Bumped when the schema changes: an older database is rebuilt at startup (jobs.ts). */
export const SCHEMA_VERSION = 2;

const INDEXES = `
CREATE INDEX cotral_stops_latlon ON cotral_stops(lat, lon);
CREATE INDEX cotral_stop_routes_route ON cotral_stop_routes(route_id, stop_id);
CREATE INDEX cotral_rail_shapes_route ON cotral_rail_shapes(route_id);
CREATE INDEX rail_trips_route ON rail_trips(route_id);
CREATE INDEX rail_stop_times_stop ON rail_stop_times(stop_id);
CREATE INDEX atac_stops_latlon ON atac_stops(lat, lon);
CREATE INDEX atac_stops_name ON atac_stops(name);
CREATE INDEX atac_shapes_route ON atac_shapes(route_id);
CREATE INDEX atac_stop_routes_route ON atac_stop_routes(route_id, stop_id);
CREATE INDEX atac_stop_headsign_stop ON atac_stop_headsign(stop_id);
CREATE TABLE atac_stop_times(
  stop_id TEXT NOT NULL, dep_secs INTEGER NOT NULL, trip_rid INTEGER NOT NULL,
  PRIMARY KEY(stop_id, dep_secs, trip_rid)) WITHOUT ROWID;
INSERT OR IGNORE INTO atac_stop_times SELECT stop_id, dep_secs, trip_rid FROM atac_stop_times_raw ORDER BY stop_id, dep_secs, trip_rid;
DROP TABLE atac_stop_times_raw;
`;

const COUNTED_TABLES = ['cotral_stops', 'cotral_routes', 'cotral_stop_routes', 'cotral_rail_shapes', 'rail_trips', 'rail_stop_times',
  'rail_calendar', 'rail_calendar_dates', 'atac_stops', 'atac_routes', 'atac_shapes', 'atac_trips',
  'atac_stop_routes', 'atac_stop_headsign', 'atac_service_dates', 'atac_route_stops', 'atac_route_directions',
  'cotral_route_stops', 'cotral_route_directions'];

type Value = string | number | null;

/** Buffers rows and writes them with multi-row prepared INSERTs (far fewer statement executions). */
class BatchInsert {
  private readonly full: Database.Statement;
  private readonly head: string;
  private readonly perBatch: number;
  private params: Value[] = [];
  private rows = 0;
  private total = 0;

  constructor(private readonly db: Database.Database, table: string, private readonly columns: string[], perBatch = 150, verb = 'INSERT') {
    this.perBatch = Math.max(1, Math.min(perBatch, Math.floor(990 / columns.length)));
    this.head = `${verb} INTO ${table} (${columns.join(',')}) VALUES `;
    this.full = db.prepare(this.head + this.placeholders(this.perBatch));
  }

  private placeholders(n: number): string {
    const one = `(${this.columns.map(() => '?').join(',')})`;
    return Array(n).fill(one).join(',');
  }

  add(...row: Value[]): void {
    for (const v of row) this.params.push(v);
    if (++this.rows >= this.perBatch) {
      this.full.run(this.params);
      this.total += this.rows;
      this.params = [];
      this.rows = 0;
    }
  }

  finish(): number {
    if (this.rows > 0) {
      this.db.prepare(this.head + this.placeholders(this.rows)).run(this.params);
      this.total += this.rows;
      this.params = [];
      this.rows = 0;
    }
    return this.total;
  }
}

/** Index-of based field access for the hot loops (no array allocation per line): PHP `explode(',', $line, 5)`. */
function split4(line: string): [string, string, string, string] | null {
  const a = line.indexOf(',');
  if (a < 0) return null;
  const b = line.indexOf(',', a + 1);
  if (b < 0) return null;
  const c = line.indexOf(',', b + 1);
  if (c < 0) return null;
  const d = line.indexOf(',', c + 1);
  return [line.slice(0, a), line.slice(a + 1, b), line.slice(b + 1, c), d < 0 ? line.slice(c + 1) : line.slice(c + 1, d)];
}

/** The 5th comma-separated field (stop_times.txt: stop_sequence), '' when absent. */
function field5(line: string): string {
  let i = -1;
  for (let k = 0; k < 4; k++) {
    i = line.indexOf(',', i + 1);
    if (i < 0) return '';
  }
  const e = line.indexOf(',', i + 1);
  return line.slice(i + 1, e < 0 ? undefined : e).trim();
}

/** `Csv::rows`: skips the header, trims spaces/tabs/CR/LF and blank lines, parses each row. */
async function csvRows(src: FeedSource, file: string, onRow: (f: string[]) => void): Promise<boolean> {
  let first = true;
  return src.eachLine(file, (raw) => {
    if (first) { first = false; return; }
    const line = phpTrim(raw, ' \t\r\n');
    if (line === '') return;
    onRow(parseCsvLine(line));
  });
}

/** Streams a raw line-oriented file (header skipped), with PHP's "drop every quote" shortcut. */
async function rawLines(src: FeedSource, file: string, onLine: (line: string) => void): Promise<boolean> {
  let first = true;
  return src.eachLine(file, (line) => {
    if (first) { first = false; return; }
    onLine(line.includes('"') ? line.replaceAll('"', '') : line);
  });
}

export class Builder {
  private db!: Database.Database;
  private readonly t0 = performance.now();
  private readonly stats: BuildStats = {};
  private peakRss = 0;

  /** stop_id => set of route indexes (Cotral bus + rail) */
  private cotralPairs = new Map<string, Set<number>>();
  /** route index => route_id (Cotral, "F:" namespaced for rail) */
  private cotralRouteIds: string[] = [];
  private cotralRouteIdx = new Map<string, number>();

  constructor(private readonly logger: Logger = (m) => process.stderr.write(m + '\n')) {}

  private log(msg: string): void {
    const { rss, heapUsed } = process.memoryUsage();
    this.peakRss = Math.max(this.peakRss, rss);
    const s = ((performance.now() - this.t0) / 1000).toFixed(1).padStart(6);
    const mb = (n: number) => String(Math.round(n / 1048576)).padStart(4);
    this.logger(`[${s}s rss ${mb(rss)}MB heap ${mb(heapUsed)}MB] ${msg}`);
  }

  private sample(): void {
    this.peakRss = Math.max(this.peakRss, process.memoryUsage().rss);
  }

  async build(feeds: Feeds, finalPath: string, sourceInfo: Record<string, string> = {}): Promise<BuildStats> {
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    fs.rmSync(tmpPath, { force: true });
    const sampler = setInterval(() => this.sample(), 500);
    try {
      this.db = new Database(tmpPath);
      this.db.pragma('journal_mode = OFF');
      this.db.pragma('synchronous = OFF');
      this.db.pragma('cache_size = -16000');
      this.db.pragma('temp_store = FILE');
      this.db.pragma('page_size = 4096');

      this.db.exec('BEGIN');
      this.db.exec(SCHEMA);
      await this.loadCotralBus(feeds.bus);
      await this.loadCotralRail(feeds.rail);
      this.writeCotralStopRoutes();
      await this.loadAtac(feeds.atac);
      this.createIndexes();
      this.writeMeta(sourceInfo);
      this.db.exec('COMMIT');

      this.log('ANALYZE');
      this.db.exec('ANALYZE');
      this.log('VACUUM');
      this.db.exec('VACUUM');
      this.db.close();
      fs.renameSync(tmpPath, finalPath);
    } catch (err) {
      try { this.db?.close(); } catch { /* already closed */ }
      fs.rmSync(tmpPath, { force: true });
      throw err;
    } finally {
      clearInterval(sampler);
    }
    this.sample();
    this.stats.db_bytes = fs.statSync(finalPath).size;
    this.stats.seconds = Math.round((performance.now() - this.t0) / 1000);
    this.stats.peak_rss_mb = Math.round(this.peakRss / 1048576);
    return this.stats;
  }

  // ------------------------------------------------------------------ schema

  private createIndexes(): void {
    this.log('indexes + compact atac_stop_times');
    this.db.exec(INDEXES);
    this.stats.atac_stop_times = this.count('atac_stop_times');
  }

  private count(table: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  private writeMeta(sourceInfo: Record<string, string>): void {
    const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const meta: Record<string, string> = { built_at: builtAt, schema_version: String(SCHEMA_VERSION), ...sourceInfo };
    const q = this.db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)');
    for (const [k, v] of Object.entries(meta)) q.run(k, v);
    for (const t of COUNTED_TABLES) this.stats[t] = this.count(t);
  }

  // ------------------------------------------------------------------ Cotral

  private cotralRouteIndex(routeId: string): number {
    let i = this.cotralRouteIdx.get(routeId);
    if (i === undefined) {
      i = this.cotralRouteIds.push(routeId) - 1;
      this.cotralRouteIdx.set(routeId, i);
    }
    return i;
  }

  private addCotralPair(stop: string, ri: number): void {
    let set = this.cotralPairs.get(stop);
    if (!set) this.cotralPairs.set(stop, (set = new Set()));
    set.add(ri);
  }

  private async loadCotralBus(src: FeedSource): Promise<void> {
    this.log('Cotral bus: stops/routes/trips');
    await this.loadCotralStops(src, false);
    await this.loadCotralRoutes(src, false);

    // trips.txt: route_id, service_id, trip_id, direction_id, shape_id -> trip_id => trip index
    const tripIndex = new Map<string, number>();
    const tripRoute: number[] = [];  // trip index => route index
    const tripDir: number[] = [];
    const tripShape: number[] = [];
    const shapeIdx = new Map<string, number>();
    await need(src, 'trips.txt', (file) => csvRows(src, file, (f) => {
      if (f.length <= 2) return;
      let t = tripIndex.get(f[2]);
      if (t === undefined) {
        t = tripIndex.size;
        tripIndex.set(f[2], t);
      }
      tripRoute[t] = this.cotralRouteIndex(f[0]);
      tripDir[t] = f.length > 3 ? directionOf(f[3]) : 0;
      tripShape[t] = f.length > 4 ? indexOf(shapeIdx, f[4]) : -1;
    }));
    this.log(`Cotral bus: stop_times (${tripIndex.size} trips)`);

    let rows = 0;
    const collector = new TripStopCollector();
    await need(src, 'stop_times.txt', (file) => rawLines(src, file, (line) => {
      const p = split4(line);
      if (!p) return;
      const t = tripIndex.get(p[0]);
      if (t === undefined) return;
      const stop = phpTrim(p[3]);
      if (stop === '') return;
      this.addCotralPair(stop, tripRoute[t]);
      collector.add(t, field5(line), stop);
      rows++;
    }));
    this.log(`  ${rows} stop_times rows scanned`);
    tripIndex.clear();

    this.log('Cotral bus: route stop order');
    this.writeRouteOrders('cotral', this.cotralRouteIds, collector, tripRoute.length, (t) => ({
      route: tripRoute[t], info: { trip: t, pattern: collector.patternOf(t), direction: tripDir[t], shape: tripShape[t], headsign: null },
    }));
  }

  /**
   * Route-order tables (`<prefix>_route_stops`, `<prefix>_route_directions`) from the collected stop_times rows.
   * `trip(t)` describes trip index t (its route index and TripInfo).
   */
  private writeRouteOrders(
    prefix: 'atac' | 'cotral', routeIds: string[], collector: TripStopCollector, tripCount: number,
    trip: (t: number) => { route: number; info: TripInfo } | null,
  ): void {
    collector.finish();
    const byRoute = new Map<number, TripInfo[]>();
    for (let t = 0; t < tripCount; t++) {
      const d = trip(t);
      if (!d) continue;
      let list = byRoute.get(d.route);
      if (!list) byRoute.set(d.route, (list = []));
      list.push(d.info);
    }
    const stops = new BatchInsert(this.db, `${prefix}_route_stops`, ['route_id', 'pos', 'stop_id'], 300);
    const dirs = new BatchInsert(this.db, `${prefix}_route_directions`, ['route_id', 'direction_id', 'headsign', 'stop_ids'], 200);
    for (const [ri, trips] of byRoute) {
      const routeId = routeIds[ri];
      const order = orderRoute(trips, (p) => collector.stopsOf(p));
      order.stops.forEach((s, pos) => stops.add(routeId, pos, collector.stopIds[s]));
      for (const d of order.directions) {
        dirs.add(routeId, d.directionId, d.headsign, JSON.stringify(d.stops.map((s) => collector.stopIds[s])));
      }
    }
    const n = stops.finish();
    dirs.finish();
    this.log(`  ${prefix}_route_stops: ${n} rows for ${byRoute.size} routes (${collector.patternCount} stop patterns)`);
  }

  private async loadCotralStops(src: FeedSource, isRail: boolean): Promise<void> {
    const ins = new BatchInsert(this.db, 'cotral_stops', ['stop_id', 'name', 'name_lc', 'locality', 'lat', 'lon', 'is_rail'], 140, 'INSERT OR REPLACE');
    await need(src, 'stops.txt', (file) => csvRows(src, file, (f) => {
      if (f.length <= 3) return;
      const name = stripTrailingHashCode(f[1]);
      ins.add(
        f[0], name, lower(name), extractLocality(name),
        phpFloatStr(isNumeric(f[2]) ? Number(f[2].trim()) : 0), phpFloatStr(isNumeric(f[3]) ? Number(f[3].trim()) : 0),
        isRail ? 1 : 0,
      );
    }));
    ins.finish();
  }

  private async loadCotralRoutes(src: FeedSource, isRail: boolean): Promise<void> {
    const prefix = isRail ? 'F:' : '';
    const ins = new BatchInsert(this.db, 'cotral_routes', ['route_id', 'short_name', 'long_name', 'is_rail', 'short_lc', 'long_lc'], 150, 'INSERT OR REPLACE');
    await need(src, 'routes.txt', (file) => csvRows(src, file, (f) => {
      if (f.length <= 3) return;
      const long = stripTrailingHashCode(f[3]);
      ins.add(prefix + f[0], f[2], long, isRail ? 1 : 0, lower(f[2]), lower(long));
    }));
    ins.finish();
  }

  private async loadCotralRail(src: FeedSource): Promise<void> {
    this.log('Cotral rail');
    await this.loadCotralStops(src, true);
    await this.loadCotralRoutes(src, true);

    // trips.txt: route_id, service_id, trip_id, direction_id, shape_id
    const tripRoute = new Map<string, number>();
    const routeShapes = new Map<string, Set<string>>();
    const trips = new BatchInsert(this.db, 'rail_trips', ['trip_id', 'route_id', 'service_id'], 200, 'INSERT OR REPLACE');
    await need(src, 'trips.txt', (file) => csvRows(src, file, (f) => {
      if (f.length <= 2) return;
      const route = 'F:' + f[0];
      trips.add(f[2], route, f[1]);
      tripRoute.set(f[2], this.cotralRouteIndex(route));
      if (f.length > 4 && f[4] !== '') addToSet(routeShapes, route, f[4]);
    }));
    trips.finish();

    // stop_times.txt (departure_time = col 2, stop_sequence = col 4), tiny file -> full parser
    const st = new BatchInsert(this.db, 'rail_stop_times', ['trip_id', 'seq', 'stop_id', 'dep_secs'], 200, 'INSERT OR REPLACE');
    await need(src, 'stop_times.txt', (file) => csvRows(src, file, (f) => {
      if (f.length <= 4) return;
      // stop->route membership counts every row (like GTFSParsing.parseStopTimes)
      const ri = tripRoute.get(f[0]);
      const stop = phpTrim(f[3]);
      if (ri !== undefined && stop !== '') this.addCotralPair(stop, ri);
      const dep = timeToSeconds(f[2]);
      if (dep === null || !isIntString(f[4])) return;
      st.add(f[0], phpInt(f[4]), f[3], dep);
    }));
    st.finish();

    // calendar.txt: service_id, monday..sunday, start_date, end_date (optional file)
    const cal = new BatchInsert(this.db, 'rail_calendar', ['service_id', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'start_date', 'end_date'], 90, 'INSERT OR REPLACE');
    await csvRows(src, 'calendar.txt', (f) => {
      if (f.length <= 9 || !ctypeDigit(f[8]) || !ctypeDigit(f[9])) return;
      const row: Value[] = [f[0]];
      for (let i = 1; i <= 7; i++) row.push(f[i] === '1' ? 1 : 0);
      row.push(phpInt(f[8]), phpInt(f[9]));
      cal.add(...row);
    });
    cal.finish();

    const cd = new BatchInsert(this.db, 'rail_calendar_dates', ['service_id', 'date', 'added'], 200, 'INSERT OR REPLACE');
    await csvRows(src, 'calendar_dates.txt', (f) => {
      if (f.length > 2 && ctypeDigit(f[1])) cd.add(f[0], phpInt(f[1]), f[2] === '1' ? 1 : 0);
    });
    cd.finish();

    if (src.has('shapes.txt')) {
      this.log('Cotral rail: shapes');
      await this.buildShapes(src, routeShapes, 'cotral_rail_shapes');
    }
  }

  private writeCotralStopRoutes(): void {
    this.log(`cotral_stop_routes (${this.cotralPairs.size} stops)`);
    // WITHOUT ROWID table: the physical order is the primary key, insertion order is irrelevant.
    const ins = new BatchInsert(this.db, 'cotral_stop_routes', ['stop_id', 'route_id'], 400, 'INSERT OR IGNORE');
    for (const [stop, routes] of this.cotralPairs) {
      for (const ri of routes) ins.add(stop, this.cotralRouteIds[ri]);
    }
    ins.finish();
    this.cotralPairs = new Map();
  }

  // ------------------------------------------------------------------ Atac

  private async loadAtac(src: FeedSource): Promise<void> {
    this.log('Atac: stops/routes');
    let ins = new BatchInsert(this.db, 'atac_stops', ['stop_id', 'name', 'name_lc', 'lat', 'lon'], 190, 'INSERT OR REPLACE');
    await need(src, 'stops.txt', (file) => csvRows(src, file, (f) => {
      if (f.length <= 5 || !isNumeric(f[4]) || !isNumeric(f[5])) return;
      ins.add(f[0], f[2], lower(f[2]), phpFloatStr(Number(f[4].trim())), phpFloatStr(Number(f[5].trim())));
    }));
    ins.finish();

    ins = new BatchInsert(this.db, 'atac_routes', ['route_id', 'short_name', 'long_name', 'kind', 'operator', 'color', 'short_lc', 'long_lc'], 120, 'INSERT OR REPLACE');
    await need(src, 'routes.txt', (file) => csvRows(src, file, (f) => {
      if (f.length <= 6) return;
      const type = isIntString(f[4]) ? phpInt(f[4]) : 3;
      const color = trimWs(f[6]);
      ins.add(f[0], f[2], f[3], type, f[1] === 'OP1' ? 'Atac' : 'Roma TPL', color === '' ? null : color, lower(f[2]), lower(f[3]));
    }));
    ins.finish();

    // trips.txt: route_id, service_id, trip_id, trip_headsign, ..., shape_id (col 7); quote-aware
    this.log('Atac: trips');
    const tripIdx = new Map<string, number>(); // trip_id => internal id (= atac_trips.rowid)
    const tripRoute: number[] = [];             // internal id - 1 => route index
    const tripHead: number[] = [];              // internal id - 1 => headsign index or -1
    const tripDir: number[] = [];               // internal id - 1 => direction_id
    const tripShape: number[] = [];             // internal id - 1 => shape index or -1
    const shapeIdx = new Map<string, number>();
    const routeIds: string[] = [];              // route index => route_id
    const routeIdx = new Map<string, number>();
    const headIdx = new Map<string, number>();  // cleaned headsign => index
    const heads: string[] = [];                 // index => cleaned headsign
    const headCache = new Map<string, number>(); // raw => index | -1
    const routeShapes = new Map<string, Set<string>>();
    const trips = new BatchInsert(this.db, 'atac_trips', ['rowid', 'trip_id', 'route_id', 'service_id', 'headsign'], 190, 'INSERT OR REPLACE');
    await need(src, 'trips.txt', (file) => csvRows(src, file, (f) => {
      if (f.length <= 7 || f[0] === '') return;
      const [route, service, trip, rawHead, shape] = [f[0], f[1], f[2], f[3], f[7]];
      if (trip !== '') {
        let ri = routeIdx.get(route);
        if (ri === undefined) {
          ri = routeIds.push(route) - 1;
          routeIdx.set(route, ri);
        }
        let hi = headCache.get(rawHead);
        if (hi === undefined) {
          const clean = cleanHeadsign(rawHead);
          if (clean === null) {
            hi = -1;
          } else {
            hi = headIdx.get(clean);
            if (hi === undefined) {
              hi = heads.push(clean) - 1;
              headIdx.set(clean, hi);
            }
          }
          headCache.set(rawHead, hi);
        }
        let id = tripIdx.get(trip);
        if (id === undefined) {
          id = tripIdx.size + 1;
          tripIdx.set(trip, id);
        }
        tripRoute[id - 1] = ri;
        tripHead[id - 1] = hi;
        tripDir[id - 1] = directionOf(f[5]);
        tripShape[id - 1] = indexOf(shapeIdx, shape);
        trips.add(id, trip, route, service === '' ? null : service, hi >= 0 ? heads[hi] : null);
      }
      if (shape !== '') addToSet(routeShapes, route, shape);
    }));
    trips.finish();
    headCache.clear();
    this.log(`  ${tripIdx.size} trips`);

    this.log('Atac: shapes');
    await this.buildShapes(src, routeShapes, 'atac_shapes');
    routeShapes.clear();

    this.log('Atac: stop_times');
    // stop_id => (route index => headsign index | -1)
    const pairs = new Map<string, Map<number, number>>();
    const raw = new BatchInsert(this.db, 'atac_stop_times_raw', ['stop_id', 'dep_secs', 'trip_rid'], 330);
    const collector = new TripStopCollector();
    let rows = 0;
    let kept = 0;
    await need(src, 'stop_times.txt', (file) => rawLines(src, file, (line) => {
      const p = split4(line);
      if (!p) return;
      const id = tripIdx.get(p[0]);
      if (id === undefined) return;
      rows++;
      const stop = p[3];
      collector.add(id - 1, field5(line), stop);
      const ri = tripRoute[id - 1];
      const hi = tripHead[id - 1];
      let byRoute = pairs.get(stop);
      if (!byRoute) pairs.set(stop, (byRoute = new Map()));
      const cur = byRoute.get(ri) ?? -2;
      if (cur === -2 || (cur === -1 && hi >= 0)) byRoute.set(ri, hi);
      const dep = timeToSeconds(p[2]);
      if (dep !== null) {
        raw.add(stop, dep, id);
        kept++;
      }
    }));
    raw.finish();
    this.log(`  ${rows} rows matched a trip, ${kept} with a departure time`);
    const tripCount = tripIdx.size;
    tripIdx.clear();

    this.log('Atac: route stop order');
    this.writeRouteOrders('atac', routeIds, collector, tripCount, (t) => (tripRoute[t] === undefined ? null : {
      route: tripRoute[t], info: {
        trip: t, pattern: collector.patternOf(t), direction: tripDir[t], shape: tripShape[t], headsign: tripHead[t] >= 0 ? heads[tripHead[t]] : null,
      },
    }));

    this.log(`Atac: stop_routes / stop_headsign (${pairs.size} stops)`);
    const sr = new BatchInsert(this.db, 'atac_stop_routes', ['stop_id', 'route_id'], 400, 'INSERT OR IGNORE');
    const sh = new BatchInsert(this.db, 'atac_stop_headsign', ['route_id', 'stop_id', 'headsign'], 250, 'INSERT OR IGNORE');
    for (const [stop, routes] of pairs) {
      for (const [ri, hi] of routes) {
        sr.add(stop, routeIds[ri]);
        if (hi >= 0) sh.add(routeIds[ri], stop, heads[hi]);
      }
    }
    sr.finish();
    sh.finish();
    pairs.clear();

    // calendar_dates.txt: service_id, date, exception_type (this feed has no calendar.txt: explicit list)
    const cd = new BatchInsert(this.db, 'atac_service_dates', ['date', 'service_id'], 400, 'INSERT OR IGNORE');
    await need(src, 'calendar_dates.txt', (file) => csvRows(src, file, (f) => {
      if (f.length >= 3 && f[2] === '1' && ctypeDigit(f[1])) cd.add(phpInt(f[1]), f[0]);
    }));
    cd.finish();
  }

  // ------------------------------------------------------------------ shapes

  /**
   * Streams shapes.txt keeping only the shapes some trip uses, and stores one encoded polyline per
   * (route_id, shape_id), in the order the routes/shapes were first seen in trips.txt (= rowid order).
   */
  private async buildShapes(src: FeedSource, routeShapes: Map<string, Set<string>>, table: string): Promise<void> {
    const wanted = new Set<string>();
    for (const set of routeShapes.values()) for (const sid of set) wanted.add(sid);

    // shape_id => packed int32 (seq, latE5, lonE5)* — like PHP's pack('l3'), compact for 500k+ points
    const buf = new Map<string, Int32Buffer>();
    await need(src, 'shapes.txt', (file) => rawLines(src, file, (line) => {
      const p = split4(line);
      if (!p) return;
      if (!wanted.has(p[0]) || !isNumeric(p[1]) || !isNumeric(p[2])) return;
      const seq = phpTrim(p[3]);
      if (seq === '' || !ctypeDigit(seq)) return;
      let a = buf.get(p[0]);
      if (!a) buf.set(p[0], (a = new Int32Buffer()));
      a.push3(phpInt(seq), phpRound(Number(p[1].trim()) * 1e5), phpRound(Number(p[2].trim()) * 1e5));
    }));

    const ins = new BatchInsert(this.db, table, ['route_id', 'shape_id', 'polyline', 'min_lat', 'min_lon', 'max_lat', 'max_lon'], 100);
    const encoded = new Map<string, ReturnType<typeof encodeShape>>();
    for (const [route, set] of routeShapes) {
      for (const sid of set) {
        const packed = buf.get(sid)?.view();
        if (!packed) continue;
        let e = encoded.get(sid);
        if (e === undefined) {
          e = encodeShape(packed);
          encoded.set(sid, e);
        }
        if (e === null) continue;
        ins.add(route, sid, e[0], phpFloatStr(e[1]), phpFloatStr(e[2]), phpFloatStr(e[3]), phpFloatStr(e[4]));
      }
    }
    const n = ins.finish();
    this.log(`  ${table}: ${n} shapes`);
  }
}

/** Polyline + bbox [minLat, minLon, maxLat, maxLon]; null with fewer than 2 points. */
function encodeShape(v: Int32Array): [string, number, number, number, number] | null {
  const n = Math.floor(v.length / 3);
  if (n < 2) return null;
  let pts: Array<[number, number, number]> = [];
  let sorted = true;
  for (let i = 0; i < n; i++) {
    if (i > 0 && v[i * 3] < v[(i - 1) * 3]) sorted = false;
    pts.push([v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]);
  }
  if (!sorted) pts = pts.sort((a, b) => a[0] - b[0]); // stable, like PHP 8 usort
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  const line: Array<[number, number]> = [];
  for (const [, lat, lon] of pts) {
    line.push([lat, lon]);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return [encodePolyline(line), minLat / 1e5, minLon / 1e5, maxLat / 1e5, maxLon / 1e5];
}

/** Growable Int32Array (amortized doubling). */
class Int32Buffer {
  private a = new Int32Array(96);
  private n = 0;
  push3(x: number, y: number, z: number): void {
    if (this.n + 3 > this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
  view(): Int32Array { return this.a.subarray(0, this.n); }
}

/** GTFS direction_id (0/1; anything else -> 0). */
function directionOf(v: string | undefined): number {
  const n = Number.parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Interns a string into a small integer (-1 for ''). */
function indexOf(map: Map<string, number>, v: string): number {
  if (v === '') return -1;
  let i = map.get(v);
  if (i === undefined) {
    i = map.size;
    map.set(v, i);
  }
  return i;
}

function addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

async function need(src: FeedSource, file: string, read: (file: string) => Promise<boolean>): Promise<void> {
  if (!(await read(file))) throw new Error(`File GTFS mancante: ${file}`);
}
