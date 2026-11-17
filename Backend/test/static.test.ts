import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  capitalized, cleanHeadsign, extractLocality, parseCsvLine, phpCompareStrings, phpFloatStr, phpRound, stripTrailingHashCode,
  timeToSeconds, trimWs,
} from '../src/gtfs/text.js';
import { decodePolyline, encodePolyline } from '../src/gtfs/polyline.js';

/**
 * Static module: builder (from the mini GTFS feeds in test/fixtures, as a folder and as zips, and once in the worker
 * thread), text helpers, rail tier logic and every HTTP endpoint against the built database.
 * The fixtures' expected values were cross-checked against Madovai-Web's PHP builder/endpoints (identical DB).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'madovai-static-'));
// config.ts reads the environment when first imported: everything that reaches it is imported dynamically below.
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.GTFS_REBUILD_AT = '';
process.env.REMINDERS_ENABLED = '0';
process.env.ASTRAL_BASE_URL = 'http://127.0.0.1:9'; // no network in tests: ASTRAL unreachable -> GTFS tier

type StoreMod = typeof import('../src/gtfs/store.js');
type RailMod = typeof import('../src/gtfs/rail.js');
let Store: StoreMod['Store'];
let romeNow: StoreMod['romeNow'];
let railDepartures: RailMod['railDepartures'];
let app: FastifyInstance;

/** Every user table's rows (rowid included where the table has one), meta minus the build-specific keys. */
function dump(file: string): Record<string, unknown[]> {
  const db = new Database(file, { readonly: true });
  const out: Record<string, unknown[]> = {};
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
  for (const t of tables) {
    const cols = t.sql.includes('WITHOUT ROWID') ? '*' : 'rowid AS _rowid, *';
    const where = t.name === 'meta' ? "WHERE key NOT IN ('built_at', 'source')" : '';
    out[t.name] = db.prepare(`SELECT ${cols} FROM ${t.name} ${where} ORDER BY 1, 2`).all();
  }
  out.__schema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
  db.close();
  return out;
}

beforeAll(async () => {
  const build = await import('../src/gtfs/build.js');
  await build.runBuild({ dataDir: process.env.DATA_DIR!, fromDir: path.join(FIXTURES, 'gtfs'), log: () => {} });
  ({ Store, romeNow } = await import('../src/gtfs/store.js'));
  ({ railDepartures } = await import('../src/gtfs/rail.js'));
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app?.close();
  (await import('../src/db.js')).closeAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json(), cache: res.headers['cache-control'] };
};

// ---------------------------------------------------------------------------------------------- helpers

describe('text helpers (ports of Text.php / Csv.php)', () => {
  it('strips the Cotral " # CODE" suffix and extracts the locality', () => {
    expect(stripTrailingHashCode('ARTENA | Campo Sportivo # 1021')).toBe('ARTENA | Campo Sportivo');
    expect(stripTrailingHashCode('Morlupo - Prima Porta #AA009A')).toBe('Morlupo - Prima Porta');
    expect(stripTrailingHashCode('A # B # C')).toBe('A # B');
    expect(stripTrailingHashCode('No code')).toBe('No code');
    expect(extractLocality('ROMA (Anagnina) Metro A')).toBe('ROMA');
    expect(extractLocality('ROMA ! Termini')).toBe('ROMA');
    expect(extractLocality('Acilia')).toBe('Acilia');
    expect(trimWs('  x\t')).toBe('x');
  });

  it('capitalizes like Swift .capitalized and cleans Atac headsigns', () => {
    expect(capitalized('P.LE FLAMINIO')).toBe('P.Le Flaminio');
    expect(capitalized("VALLE D'AOSTA")).toBe("Valle D'aosta");
    expect(capitalized('A1B C-D')).toBe('A1B C-D');
    expect(capitalized('CINECITTA\'')).toBe("Cinecitta'");
    expect(cleanHeadsign('ANAGNINA (MA)')).toBe('Anagnina');
    expect(cleanHeadsign('TUSCOLANA/ANAGNINA')).toBe('Tuscolana/Anagnina');
    expect(cleanHeadsign('  ')).toBeNull();
  });

  it('parses CSV lines and GTFS times like the iOS parser', () => {
    expect(parseCsvLine('a,b,,c')).toEqual(['a', 'b', '', 'c']);
    expect(parseCsvLine('"a","b ""q"" c","d,e"')).toEqual(['a', 'b "q" c', 'd,e']);
    expect(parseCsvLine('"f5236","X I.I.S. "T" P # f5236","1"')).toEqual(['f5236', 'X I.I.S. T P # f5236', '1']);
    expect(timeToSeconds('05:20:30')).toBe(19230);
    expect(timeToSeconds('25:10:00')).toBe(90600);
    expect(timeToSeconds('5:20:30')).toBe(19230);
    expect(timeToSeconds('')).toBeNull();
    expect(timeToSeconds('aa:bb:cc')).toBeNull();
  });

  it('reproduces PHP number semantics', () => {
    expect(phpRound(4112345.5)).toBe(4112346);
    expect(phpRound(-2.5)).toBe(-3);
    expect(phpFloatStr(41.6031449889606)).toBe('41.603144988961');
    expect(phpFloatStr(12)).toBe('12');
    expect(phpFloatStr(0.55)).toBe('0.55');
    expect(phpFloatStr(0.00001)).toBe('1.0E-5');
    expect(phpCompareStrings('9', '10')).toBeLessThan(0);
    expect(phpCompareStrings('T9', 'T10')).toBeGreaterThan(0);
  });

  it('encodes Google polylines', () => {
    const pts: Array<[number, number]> = [[3850000, -12020000], [4070000, -12095000], [4325200, -12645300]];
    const enc = encodePolyline(pts);
    expect(enc).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline(enc)).toEqual([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  });

  it('computes the real Rome midnight, also on DST days', () => {
    expect(romeNow(new Date('2026-11-06T09:00:00Z'))).toMatchObject({ ymd: 20261106, isoWeekday: 5, secondsSinceMidnight: 36000, midnightUnix: Date.parse('2026-11-05T23:00:00Z') / 1000 });
    expect(romeNow(new Date('2026-03-29T10:00:00Z')).midnightUnix).toBe(Date.parse('2026-03-28T23:00:00Z') / 1000);
    expect(romeNow(new Date('2026-10-25T10:00:00Z')).midnightUnix).toBe(Date.parse('2026-10-24T22:00:00Z') / 1000);
    expect(romeNow(new Date('2026-11-08T12:00:00Z')).isoWeekday).toBe(7);
  });
});

// ---------------------------------------------------------------------------------------------- builder

describe('builder', () => {
  it('writes the PHP schema and rows', () => {
    const d = dump(path.join(process.env.DATA_DIR!, 'madovai.sqlite'));
    const names = (d.__schema as { name: string }[]).map((r) => r.name);
    for (const t of ['meta', 'cotral_stops', 'cotral_routes', 'cotral_stop_routes', 'cotral_rail_shapes', 'rail_trips', 'rail_stop_times',
      'rail_calendar', 'rail_calendar_dates', 'atac_stops', 'atac_routes', 'atac_shapes', 'atac_trips', 'atac_stop_routes',
      'atac_stop_headsign', 'atac_service_dates', 'atac_stop_times', 'cotral_stops_latlon', 'atac_stop_times']) expect(names).toContain(t);
    expect(names).not.toContain('atac_stop_times_raw');
    expect(d.cotral_stops).toContainEqual({ _rowid: 2, stop_id: 'f5236', name: 'FROSINONE | I.I.S. Turriziani Piazza Gramsci', name_lc: 'frosinone | i.i.s. turriziani piazza gramsci', locality: 'FROSINONE', lat: 41.6338091323, lon: 13.3524603189, is_rail: 0 });
    expect(d.cotral_routes).toContainEqual({ _rowid: 3, route_id: 'F:ROMALIDO', short_name: 'ROMALIDO', long_name: 'METROMARE', is_rail: 1, short_lc: 'romalido', long_lc: 'metromare' });
    expect(d.cotral_stop_routes).toHaveLength(7); // bus: 7001/1021 x 126, 7002/f5236 x 2003 (unknown trip ignored) + rail 3 stations
    expect(d.atac_trips).toEqual([
      { _rowid: 1, trip_id: '1#1-1', route_id: 'MEA', service_id: 'S1', headsign: 'Anagnina' },
      { _rowid: 2, trip_id: '1#1-2', route_id: 'MEA', service_id: 'S1', headsign: 'Battistini' },
      { _rowid: 3, trip_id: '1#2-1', route_id: '211', service_id: 'S1', headsign: 'P.Le Flaminio' },
      { _rowid: 4, trip_id: '1#2-2', route_id: '211', service_id: 'S2', headsign: "Valle D'aosta" },
      { _rowid: 5, trip_id: '1#3-1', route_id: '8', service_id: 'S1', headsign: null },
      { _rowid: 6, trip_id: '1#4-1', route_id: 'C11', service_id: 'S1', headsign: 'Cimitero Laurentino' },
    ]);
    // trip_rid = atac_trips.rowid; the trip missing from trips.txt is dropped
    expect(d.atac_stop_times).toEqual(expect.arrayContaining([{ stop_id: '05000', dep_secs: 90600, trip_rid: 5 }]));
    expect(d.atac_stop_times).toHaveLength(10);
    expect(d.atac_stop_headsign).toContainEqual({ route_id: 'MEA', stop_id: '05000', headsign: 'Anagnina' });
    // shapes: one per (route, shape) in first-seen order; single-point SH4 and unused S3 skipped; S1 sorted by sequence
    expect(d.atac_shapes.map((r) => (r as { shape_id: string }).shape_id)).toEqual(['SH1', 'SH2', 'SH3']);
    expect(d.cotral_rail_shapes).toContainEqual(expect.objectContaining({ route_id: 'F:ROMALIDO', shape_id: 'S1', polyline: 'wuq~F{zdkAb|PbuV~xKbxH' }));
    expect(d.rail_calendar_dates).toEqual([{ service_id: 'SUN', date: 20261208, added: 1 }, { service_id: 'WD', date: 20261208, added: 0 }]);
    expect(d.atac_service_dates).toEqual([{ date: 20261106, service_id: 'S1' }, { date: 20261107, service_id: 'S2' }]);
    expect(d.meta).toEqual([{ key: 'schema_version', value: '2' }]);
    // schema 2: route order (details in line-search.test.ts)
    expect(d.atac_route_stops).toEqual([
      { route_id: '211', pos: 0, stop_id: '05001' }, { route_id: '211', pos: 1, stop_id: '70181' },
      { route_id: '8', pos: 0, stop_id: '05001' }, { route_id: '8', pos: 1, stop_id: '05000' },
      { route_id: 'MEA', pos: 0, stop_id: '05000' }, { route_id: 'MEA', pos: 1, stop_id: '70180' },
    ]);
    expect(d.cotral_route_stops).toEqual([
      { route_id: '126', pos: 0, stop_id: '7001' }, { route_id: '126', pos: 1, stop_id: '1021' },
      { route_id: '2003', pos: 0, stop_id: '7002' }, { route_id: '2003', pos: 1, stop_id: 'f5236' },
    ]);
  });

  it('reads zips (entries in subfolders) exactly like folders', async () => {
    const { runBuild } = await import('../src/gtfs/build.js');
    const dir = path.join(tmp, 'zips');
    const stats = await runBuild({ dataDir: dir, fromZips: path.join(FIXTURES, 'gtfs-zips'), log: () => {} });
    expect(stats.atac_stop_times).toBe(10);
    expect(fs.readdirSync(dir).sort()).toEqual(['madovai.sqlite']); // no temp file, lock released
    expect(dump(path.join(dir, 'madovai.sqlite'))).toEqual(dump(path.join(process.env.DATA_DIR!, 'madovai.sqlite')));
  });

  it('refuses to overlap a running build (lock)', async () => {
    const { acquireBuildLock, BuildLockedError } = await import('../src/gtfs/build.js');
    const dir = path.join(tmp, 'lock');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'build.lock'), String(process.ppid)); // another live process
    expect(() => acquireBuildLock(dir)).toThrow(BuildLockedError);
    fs.writeFileSync(path.join(dir, 'build.lock'), '999999999'); // dead pid: stale, taken over
    const release = acquireBuildLock(dir);
    expect(fs.readFileSync(path.join(dir, 'build.lock'), 'utf8')).toBe(String(process.pid));
    release();
    expect(fs.existsSync(path.join(dir, 'build.lock'))).toBe(false);
  });

  it('builds in a worker thread', async () => {
    const { buildInWorker } = await import('../src/gtfs/jobs.js');
    const dir = path.join(tmp, 'worker');
    const logs: string[] = [];
    const log = { info: (_o: unknown, m?: string) => { if (m) logs.push(m); }, warn: () => {}, error: () => {} };
    const stats = await buildInWorker(log as never, { dataDir: dir, fromDir: path.join(FIXTURES, 'gtfs') });
    expect(stats.atac_trips).toBe(6);
    expect(logs.some((m) => m.includes('VACUUM'))).toBe(true);
    expect(dump(path.join(dir, 'madovai.sqlite'))).toEqual(dump(path.join(process.env.DATA_DIR!, 'madovai.sqlite')));
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------- rail tiers

describe('rail tier logic (RailService port)', () => {
  const friday = new Date('2026-11-06T09:00:00Z');
  const entry = (id: string, sortSeconds: number) => ({ id, time: 'x', sortSeconds, delayMinutes: 1, isCancelled: false, isReplacementBus: false });

  it('uses ASTRAL when at least one direction resolves (entries and directions sorted)', async () => {
    const calls: string[] = [];
    const astral = async (route: string, station: string) => {
      calls.push(`${route}@${station}`);
      if (route === 'RL_CC-PSP') return { destination: 'Porta San Paolo', route, entries: [entry('b', 200), entry('a', 100)] };
      if (route === 'RL_PSP-CC') throw new Error('boom'); // a failing direction is skipped
      return null;
    };
    const r = await railDepartures(Store.open(), 'RL_ACILIA', astral, friday);
    expect(calls).toEqual(['RL_CC-PSP@Acilia', 'RL_PSP-CC@Acilia']);
    expect(r.source).toBe('astral');
    expect(r.directions).toEqual([{ destination: 'Porta San Paolo', route: 'RL_CC-PSP', entries: [entry('a', 100), entry('b', 200)] }]);
  });

  it('falls back to the GTFS timetable, grouped by destination', async () => {
    const r = await railDepartures(Store.open(), 'RL_ACILIA', async () => null, friday);
    expect(r).toEqual({
      source: 'gtfs',
      directions: [
        { destination: 'Acilia', route: null, entries: [{ id: 'T4', time: '00:30', sortSeconds: 88200, delayMinutes: null, isCancelled: false, isReplacementBus: false }] },
        { destination: 'Cristoforo Colombo', route: null, entries: [{ id: 'T1', time: '05:20', sortSeconds: 19230, delayMinutes: null, isCancelled: false, isReplacementBus: false }] },
        { destination: 'Porta San Paolo', route: null, entries: [{ id: 'T2', time: '06:10', sortSeconds: 22200, delayMinutes: null, isCancelled: false, isReplacementBus: false }] },
      ],
    });
    // calendar_dates override: 8 Dec swaps the weekday service for the Sunday one
    const holiday = await railDepartures(Store.open(), 'RL_ACILIA', null, new Date('2026-12-08T11:00:00Z'));
    expect(holiday.directions.map((d) => d.entries.map((e) => e.id))).toEqual([['T3']]);
  });

  it('returns none for bus poles and 400 for unknown stops', async () => {
    expect(await railDepartures(Store.open(), '1021', async () => { throw new Error('not called'); })).toEqual({ source: 'none', directions: [] });
    await expect(railDepartures(Store.open(), 'nope', null)).rejects.toThrow('Fermata inesistente');
  });
});

// ---------------------------------------------------------------------------------------------- HTTP

describe('HTTP endpoints', () => {
  const box = 'minLat=41.80&minLon=12.40&maxLat=41.95&maxLon=12.60';

  it('stops: bbox, nearest to the centre first, limits clamped, same JSON on the legacy path', async () => {
    const r = await get(`/api/v1/stops?${box}`);
    expect(r.status).toBe(200);
    expect(r.cache).toBe('public, max-age=30');
    // centre (41.875, 12.5): equirectangular distance, longitude scaled by cos²(lat)
    expect(r.body.cotral.map((s: { id: string }) => s.id)).toEqual(['RL_PORTASPAOLO', '7002', '7001']);
    expect(r.body.cotral[1]).toEqual({ id: '7002', name: 'ROMA ! Termini', locality: 'ROMA', lat: 41.901, lon: 12.501, rail: false });
    expect(r.body.cotral[0].rail).toBe(true);
    expect(r.body.atac.map((s: { id: string }) => s.id)).toEqual(['05001', '05000', '70181', '70180']);
    expect(r.body.atac[1]).toEqual({ id: '05000', name: 'TERMINI (MA-MB-FS)', lat: 41.901308, lon: 12.500433 });
    expect((await get(`/api/stops.php?${box}`)).body).toEqual(r.body);
    expect((await get(`/api/v1/stops?${box}&cotralLimit=0&atacLimit=99999`)).body.cotral).toHaveLength(1);
    expect((await get(`/api/v1/stops?${box}&cotralLimit=`)).status).toBe(200);
  });

  it('stops: PHP validation messages, no-store on errors', async () => {
    expect(await get('/api/v1/stops?minLat=42&minLon=12&maxLat=41&maxLon=13')).toEqual({ status: 400, body: { error: 'Riquadro non valido' }, cache: 'no-store' });
    expect((await get('/api/v1/stops?minLat=abc&minLon=12&maxLat=41&maxLon=13')).body).toEqual({ error: "Parametro 'minLat' non valido" });
    expect((await get('/api/v1/stops')).body).toEqual({ error: "Parametro 'minLat' non valido" });
    expect((await get(`/api/v1/stops?${box}&atacLimit=1.5`)).body).toEqual({ error: "Parametro 'atacLimit' non valido" });
  });

  it('search: ranked stops (metro flag) and routes, Cotral and Atac merged', async () => {
    const r = await get('/api/v1/search?q=termini');
    expect(r.cache).toBe('public, max-age=60');
    // "TERMINI (MA-MB-FS)" starts with the query, "ROMA ! Termini" only has it at a word start
    expect(r.body.stops).toEqual([
      { source: 'atac', id: '05000', name: 'TERMINI (MA-MB-FS)', lat: 41.901308, lon: 12.500433, rail: false, metro: true },
      { source: 'atac', id: '05001', name: 'TERMINI (MA-MB-FS)', lat: 41.901, lon: 12.501, rail: false, metro: false },
      { source: 'cotral', id: '7002', name: 'ROMA ! Termini', lat: 41.901, lon: 12.501, rail: false },
    ]);
    // starts with "a" (AA009A, AB017B), then "a" at a word start ("Metro A", "Casaletto - Argentina"), then "METROMARE"
    const routes = (await get('/api/search.php?q=a')).body.routes.map((x: { id: string }) => x.id);
    expect(routes).toEqual(['2003', '126', 'MEA', '8', 'F:ROMALIDO']);
    const mea = (await get('/api/v1/search?q=mea')).body.routes;
    expect(mea).toEqual([{ source: 'atac', id: 'MEA', shortName: 'MEA', longName: '', displayName: 'Metro A', kind: 'metro', operator: 'Atac', color: 'E85C1F', rail: false }]);
    expect((await get('/api/v1/search?q=%25')).body).toEqual({ stops: [], routes: [] });
    expect((await get('/api/v1/search?q=')).body).toEqual({ stops: [], routes: [] });
    expect((await get('/api/v1/search')).body).toEqual({ stops: [], routes: [] });
  });

  it('lines: all Atac routes + Cotral rail', async () => {
    const r = await get('/api/v1/lines');
    expect(r.cache).toBe('public, max-age=3600');
    expect(r.body.atac.map((x: { id: string }) => x.id)).toEqual(['211', '8', 'C11', 'MEA']);
    expect(r.body.atac[1]).toMatchObject({ displayName: 'Casaletto - Argentina', kind: 'tram', operator: 'Atac', color: null });
    expect(r.body.atac[2]).toMatchObject({ operator: 'Roma TPL' });
    expect(r.body.cotralRail).toEqual([{ source: 'cotral', id: 'F:ROMALIDO', shortName: 'ROMALIDO', longName: 'METROMARE', displayName: 'ROMALIDO', kind: 'treno', operator: 'Cotral', color: null, rail: true }]);
  });

  it('line: Atac stops in route order with headsign, rail stations in line order, bus stops in route order', async () => {
    const atac = (await get('/api/v1/line?source=atac&id=MEA')).body;
    expect(atac.stops).toEqual([
      { id: '05000', name: 'TERMINI (MA-MB-FS)', lat: 41.901308, lon: 12.500433, headsign: 'Anagnina' },
      { id: '70180', name: 'ANAGNINA', lat: 41.8423, lon: 12.5866, headsign: 'Anagnina' },
    ]);
    expect(atac.directions).toEqual([
      { directionId: 0, headsign: 'Anagnina', stopIds: ['05000', '70180'] },
      { directionId: 1, headsign: 'Battistini', stopIds: ['70180', '05000'] },
    ]);
    expect(atac.shapes).toEqual([
      { id: 'SH1', coords: 'ezv~FunhkAxoJqyO', bbox: [41.8423, 12.50043, 41.90131, 12.5866] },
      { id: 'SH2', coords: 'kik~FgiykAyoJpyO', bbox: [41.8423, 12.50043, 41.90131, 12.5866] },
    ]);
    const rail = (await get('/api/line.php?source=cotral&id=F:ROMALIDO')).body;
    expect(rail.stops.map((s: { id: string }) => s.id)).toEqual(['RL_PORTASPAOLO', 'RL_ACILIA', 'RL_COLOMBO']);
    expect(rail.stops[0].headsign).toBeNull();
    expect(rail.shapes.map((s: { id: string }) => s.id)).toEqual(['S1', 'S2']);
    const bus = (await get('/api/v1/line?source=cotral&id=126')).body;
    expect(bus.stops.map((s: { id: string }) => s.id)).toEqual(['7001', '1021']);
    expect(bus.shapes).toEqual([]);
    expect((await get('/api/v1/line?source=cotral&id=nope')).body).toEqual({ error: 'Linea inesistente' });
    expect((await get('/api/v1/line?source=xyz&id=MEA')).body).toEqual({ error: "Parametro 'source' non valido" });
    expect((await get('/api/v1/line?source=atac')).body).toEqual({ error: "Parametro 'id' mancante" });
  });

  it('shapes: Atac shapes intersecting the box', async () => {
    const r = await get(`/api/v1/shapes?${box}&limit=2`);
    expect(r.cache).toBe('public, max-age=300');
    expect(r.body).toEqual({
      shapes: [
        { id: 'SH1', routeId: 'MEA', kind: 'metro', color: 'E85C1F', coords: 'ezv~FunhkAxoJqyO', bbox: [41.8423, 12.50043, 41.90131, 12.5866] },
        { id: 'SH2', routeId: 'MEA', kind: 'metro', color: 'E85C1F', coords: 'kik~FgiykAyoJpyO', bbox: [41.8423, 12.50043, 41.90131, 12.5866] },
      ],
    });
    expect((await get('/api/v1/shapes?minLat=0&minLon=0&maxLat=1&maxLon=1')).body).toEqual({ shapes: [] });
  });

  it('atac-stop: platforms sharing the name', async () => {
    const r = await get('/api/v1/atac-stop?id=05000');
    expect(r.body).toEqual({
      name: 'TERMINI (MA-MB-FS)',
      stops: [
        { id: '05000', name: 'TERMINI (MA-MB-FS)', lat: 41.901308, lon: 12.500433, headsign: 'Anagnina' },
        { id: '05001', name: 'TERMINI (MA-MB-FS)', lat: 41.901, lon: 12.501, headsign: 'P.Le Flaminio' },
      ],
    });
    const byRoute = (await get('/api/atac-stop.php?id=05000&route=MEA')).body;
    expect(byRoute.stops.map((s: { headsign: string | null }) => s.headsign)).toEqual(['Anagnina', null]);
    expect((await get('/api/v1/atac-stop?id=nope')).body).toEqual({ error: 'Fermata inesistente' });
  });

  it('atac-schedule: today\'s services, departures from now, 6 max', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-06T06:00:00Z')); // 07:00 Rome
      const midnight = Date.parse('2026-11-05T23:00:00Z') / 1000;
      const r = await get('/api/v1/atac-schedule?stop=05000');
      expect(r.cache).toBe('public, max-age=30');
      expect(r.body).toEqual([
        { tripId: '1#1-1', routeId: 'MEA', routeLabel: 'MEA', kind: 'metro', ts: midnight + 8 * 3600, headsign: 'Anagnina' },
        { tripId: '1#1-2', routeId: 'MEA', routeLabel: 'MEA', kind: 'metro', ts: midnight + 9 * 3600 + 20 * 60, headsign: 'Anagnina' },
        { tripId: '1#3-1', routeId: '8', routeLabel: '8', kind: 'tram', ts: midnight + 25 * 3600 + 10 * 60, headsign: null },
      ]);
      vi.setSystemTime(new Date('2026-11-07T06:00:00Z')); // Saturday: only S2
      expect((await get('/api/v1/atac-schedule?stop=05001')).body.map((x: { tripId: string }) => x.tripId)).toEqual(['1#2-2']);
    } finally {
      vi.useRealTimers();
    }
    expect((await get('/api/v1/atac-schedule')).body).toEqual({ error: "Parametro 'stop' mancante" });
  });

  it('pole: static Cotral pole with ASTRAL candidate directions', async () => {
    const r = await get('/api/v1/pole?id=RL_ACILIA');
    expect(r.cache).toBe('public, max-age=3600');
    expect(r.body).toEqual({ id: 'RL_ACILIA', name: 'Acilia', locality: 'Acilia', lat: 41.7832974, lon: 12.36061706, rail: true, trainRoutes: ['RL_CC-PSP', 'RL_PSP-CC'] });
    expect((await get('/api/pole.php?id=1021')).body.trainRoutes).toEqual([]);
    expect((await get('/api/v1/pole?id=nope')).body).toEqual({ error: 'Palina inesistente' });
    expect((await get('/api/v1/pole?id=')).body).toEqual({ error: "Parametro 'id' non valido" });
  });

  it('rail: ASTRAL unreachable -> GTFS tier, no-store', async () => {
    const r = await get('/api/v1/rail?stop=RL_ACILIA');
    expect(r.status).toBe(200);
    expect(r.cache).toBe('no-store');
    expect(r.body.source).toBe('gtfs');
    expect(r.body.directions.map((d: { destination: string }) => d.destination)).toEqual(['Acilia', 'Cristoforo Colombo', 'Porta San Paolo']);
    expect((await get('/api/rail.php?stop=1021')).body).toEqual({ source: 'none', directions: [] });
    expect((await get('/api/v1/rail?stop=nope')).status).toBe(400);
  }, 30_000);

  it('documents every static route in OpenAPI', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/docs/json' })).json();
    for (const p of ['stops', 'search', 'lines', 'line', 'shapes', 'atac-stop', 'atac-schedule', 'pole', 'rail']) {
      expect(spec.paths[`/api/v1/${p}`]?.get?.tags).toEqual(['static']);
      expect(spec.paths[`/api/${p}.php`]).toBeUndefined();
    }
  });
});
