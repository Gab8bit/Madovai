import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

/**
 * Live module: Cotral XML, ASTRAL, GTFS-Realtime, Atac enrichment, departure status, routes.
 * Mirrors Madovai-Web/tests/php/run.php (same fixtures, same expectations) plus route-level tests with stubbed upstreams.
 * Config reads the environment at import time, so every app module is imported dynamically after setting it.
 */
const FIX = path.join(import.meta.dirname, 'fixtures', 'live');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'madovai-live-'));

// ---- ASTRAL stub (plain HTTP: ASTRAL_BASE_URL is the test-only override) ----------------------------------------
const astralCalls: string[] = [];
let astralFailFermata = '';
const astral = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    astralCalls.push(`${req.url} ${body}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/fermate/RL_PSP-CC') {
      res.end(JSON.stringify([
        { nomeFermata: 'Cristoforo Colombo', codice: 'ff90004', ordine: 14 },
        { nomeFermata: 'Porta San Paolo', codice: 'ff90009', ordine: 1 },
        { nomeFermata: 'Acilia Sud ', codice: 'ff90001', ordine: 10 },
      ]));
      return;
    }
    if (req.url === '/api/transit') {
      const { fermata } = JSON.parse(body) as { fermata: string };
      if (fermata === astralFailFermata) { res.statusCode = 500; res.end('{}'); return; }
      res.end(JSON.stringify([
        { orario: '00:01', corsa: 'EARLY', ritardo: '0', soppressa: 'N', busSostitutivo: 'N' },
        { orario: '23:58', corsa: 'LATE', ritardo: '', soppressa: 'Y', busSostitutivo: 'N' },
        { orario: '23:59', corsa: 'LAST', ritardo: '3', soppressa: 'N', busSostitutivo: 'Y' },
      ]));
      return;
    }
    res.statusCode = 404;
    res.end('[]');
  });
});

type Mods = {
  cotral: typeof import('../src/live/cotral.js');
  astral: typeof import('../src/live/astral.js');
  rt: typeof import('../src/live/gtfsRealtime.js');
  atac: typeof import('../src/live/atac.js');
  dep: typeof import('../src/live/departureStatus.js');
  train: typeof import('../src/live/cotralTrainRoute.js');
  fanout: typeof import('../src/live/fanout.js');
  cache: typeof import('../src/lib/cache.js');
  app: typeof import('../src/app.js');
};
let m: Mods;

beforeAll(async () => {
  await new Promise<void>((r) => astral.listen(0, '127.0.0.1', r));
  process.env.DATA_DIR = dataDir;
  process.env.ASTRAL_BASE_URL = `http://127.0.0.1:${(astral.address() as AddressInfo).port}/api`;
  process.env.LOG_LEVEL = 'silent';
  process.env.REMINDERS_ENABLED = 'false';
  m = {
    cotral: await import('../src/live/cotral.js'),
    astral: await import('../src/live/astral.js'),
    rt: await import('../src/live/gtfsRealtime.js'),
    atac: await import('../src/live/atac.js'),
    dep: await import('../src/live/departureStatus.js'),
    train: await import('../src/live/cotralTrainRoute.js'),
    fanout: await import('../src/live/fanout.js'),
    cache: await import('../src/lib/cache.js'),
    app: await import('../src/app.js'),
  };
});

afterAll(async () => {
  vi.unstubAllGlobals();
  (await import('../src/db.js')).closeAll();
  await new Promise<void>((r) => astral.close(() => r()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const rome = (s: string) => new Date(`${s}+02:00`); // October 2026 = CEST

// ---- time utils ------------------------------------------------------------------------------------------------
describe('Cotral time utils', () => {
  it('readableTime', () => {
    const { readableTime } = m.cotral;
    expect(readableTime('37800')).toBe('10:30');
    expect(readableTime('89280')).toBe('00:48');
    expect(readableTime('89280', false)).toBe('24:48');
    expect(readableTime('-15')).toBe('-00:00');
    expect(readableTime('-3600', false)).toBe('-01:00');
    expect(readableTime('abc')).toBe('00:00');
    expect(readableTime(' 60 ')).toBe('00:01');
  });
  it('normalizeLatLon / isValidCode', () => {
    const { normalizeLatLon, isValidCode } = m.cotral;
    expect(normalizeLatLon(12.9, 41.7)).toEqual([41.7, 12.9]);
    expect(normalizeLatLon(41.7, 12.9)).toEqual([41.7, 12.9]);
    expect(normalizeLatLon(0, 0)).toEqual([0, 0]);
    expect(isValidCode('ff90009')).toBe(true);
    expect(isValidCode('a b')).toBe(false);
    expect(isValidCode('a'.repeat(65))).toBe(false);
    expect(isValidCode('')).toBe(false);
  });
});

// ---- Cotral XML ------------------------------------------------------------------------------------------------
describe('Cotral XML', () => {
  it('no-data replies', () => {
    const { parseXml, parseTransits } = m.cotral;
    expect(parseXml('\n\n </transiti>\n\n')).toBeNull();
    expect(parseXml('  \n')).toBeNull();
    expect(parseXml('<a><b></a>')).toBeNull();
    expect(parseTransits('\n </transiti>\n')).toBeNull();
    expect(parseTransits('<transiti><palina><codice>1</codice></palina></transiti>')).toBeNull();
  });

  it('parses the captured pole 1021 reply', () => {
    const r = m.cotral.parseTransits(fs.readFileSync(path.join(FIX, 'cotral_pole_1021.xml')))!;
    expect(r).not.toBeNull();
    expect(r.pole).toEqual({ code: '1021', name: 'ARTENA, Campo Sportivo', stopName: 'via G.Marconi',
      locality: 'Artena (Comune)', comune: 'Artena', lat: 41.7465425153811, lon: 12.9150993838911 });
    expect(r.transits).toHaveLength(2);
    const t = r.transits[0];
    expect(t.orarioPartenzaCorsa).toBe('10:30');
    expect(t.tempoTransito).toBe('10:56');
    expect(t.ritardoSeconds).toBe(358);
    expect([t.vehicleCode, t.vehicleAlive, t.monitorata]).toEqual(['6106', true, '1']);
    expect(t.banchina).toBe('');
    expect(m.cotral.isDelayReliable(t)).toBe(true);
    expect(m.cotral.canTrackVehicle(t)).toBe(true);
  });

  it('edge cases: swapped coords, wrap, missing fields, automezzo variants', () => {
    const x = m.cotral.parseTransits('<transiti><palina><codice>9</codice><latitudine>12.5</latitudine><longitudine>41.9</longitudine></palina>'
      + '<corsa><idCorsa>1</idCorsa><orarioPartenzaCorsa>89280</orarioPartenzaCorsa><tempoTransito>x</tempoTransito><ritardo>-15</ritardo>'
      + '<automezzo>n.d.</automezzo><monitorata>0</monitorata><soppressa>Y</soppressa></corsa>'
      + '<corsa><idCorsa>2</idCorsa><automezzo isAlive="0">77</automezzo><monitorata>1</monitorata></corsa>'
      + '<corsa><idCorsa>3</idCorsa><monitorata>1</monitorata></corsa></transiti>')!;
    expect([x.pole.lat, x.pole.lon]).toEqual([41.9, 12.5]);
    const t = x.transits;
    expect(t[0].orarioPartenzaCorsa).toBe('00:48');
    expect(t[0].tempoTransito).toBe('00:00');
    expect(t[0].ritardoSeconds).toBe(-15);
    expect([t[0].vehicleCode, m.cotral.canTrackVehicle(t[0])]).toEqual(['n.d.', false]);
    expect([m.cotral.canTrackVehicle(t[1]), m.cotral.isDelayReliable(t[1])]).toEqual([true, false]);
    expect([t[2].vehicleCode, t[2].vehicleAlive, m.cotral.canTrackVehicle(t[2])]).toEqual([null, false, false]);
    expect(t[2].ritardoSeconds).toBe(0);
  });

  it('falls back to Latin-1 on invalid UTF-8', () => {
    const xml = Buffer.concat([
      Buffer.from('<transiti><palina><codice>1</codice><nomePalina>CITT'),
      Buffer.from([0xc0]), // "À" in Latin-1, invalid as UTF-8
      Buffer.from('</nomePalina></palina><corsa><idCorsa>1</idCorsa></corsa></transiti>'),
    ]);
    expect(m.cotral.parseTransits(xml)!.pole.name).toBe('CITTÀ');
  });

  it('vehicle positions', () => {
    const { parsePosition } = m.cotral;
    expect(parsePosition('<listaPosizioni><posizione pX="41.1 41.2" pY="12.1 12.2">10:45:36</posizione></listaPosizioni>')).toEqual({ lat: 41.2, lon: 12.2 });
    expect(parsePosition('<l><posizione pX="0" pY="0">x</posizione></l>')).toBeNull();
    expect(parsePosition('<l></l>')).toBeNull();
    expect(parsePosition('<l><posizione pX="a" pY="b"/></l>')).toBeNull();
    expect(parsePosition('</listaPosizioni>')).toBeNull();
  });
});

// ---- ASTRAL ----------------------------------------------------------------------------------------------------
describe('ASTRAL', () => {
  it('stations, name matching, entries', () => {
    const { parseStations, resolveFermata, parseTransits, upcoming } = m.astral;
    const stations = parseStations([
      { nomeFermata: 'Cristoforo Colombo', codice: 'ff90004', ordine: 14 },
      { nomeFermata: 'Porta San Paolo', codice: 'ff90009', ordine: 1 },
      { nomeFermata: 'Acilia Sud ', codice: 'ff90001', ordine: 10 },
      { codice: 'broken' },
    ]);
    expect(stations.map((s) => s.order)).toEqual([1, 10, 14]);
    expect(resolveFermata(stations, '  porta SAN paolo')).toBe('ff90009');
    expect(resolveFermata(stations, 'Acilia')).toBe('ff90001');
    expect(resolveFermata(stations, 'Stazione Cristoforo Colombo FS')).toBe('ff90004');
    expect(resolveFermata(stations, 'Roma Termini')).toBeNull();
    expect(resolveFermata(stations, '   ')).toBeNull();
    expect(() => parseStations([])).toThrow();

    const e = parseTransits([
      { orario: '05:15', corsa: 'RL53', ritardo: '0', soppressa: 'N', busSostitutivo: 'N' },
      { orario: '25:10', corsa: '5175', ritardo: '', soppressa: ' y ', busSostitutivo: 'Y' },
      { orario: '07:00', corsa: 'RL2', ritardo: '-2', soppressa: 'N', busSostitutivo: '' },
      { orario: 'bad', corsa: 'X', ritardo: '1', soppressa: 'N', busSostitutivo: 'N' },
    ]);
    expect(e).toHaveLength(3);
    expect(e[0]).toEqual({ id: 'RL53', time: '05:15', sortSeconds: 18900, delayMinutes: 0, isCancelled: false, isReplacementBus: false });
    expect([e[1].delayMinutes, e[1].isCancelled, e[1].isReplacementBus, e[1].sortSeconds]).toEqual([null, true, true, 90600]);
    expect(e[2].delayMinutes).toBe(-2);
    expect(upcoming(e, 6 * 3600).map((x) => x.id)).toEqual(['RL2', '5175']);
  });

  it('astralDepartures resolves the station (stub) and returns the whole day', async () => {
    const d = await m.astral.astralDepartures('RL_PSP-CC', 'acilia');
    expect(d!.destination).toBe('Cristoforo Colombo');
    expect(d!.route).toBe('RL_PSP-CC');
    expect(d!.entries.map((x) => x.id)).toEqual(['EARLY', 'LATE', 'LAST']);
    expect(astralCalls).toContain('/api/transit {"percorso":"RL_PSP-CC","fermata":"ff90001"}');
    expect(await m.astral.astralDepartures('RL_PSP-CC', 'Roma Termini')).toBeNull();
    await expect(m.astral.astralDepartures('BOGUS', 'x')).rejects.toThrow('Percorso non valido');
  });

  it('train routes', () => {
    expect(m.train.TRAIN_ROUTE_CODES).toHaveLength(8);
    expect(m.train.isTrainRoute('RV_VITCAT')).toBe(true);
    expect(m.train.isTrainRoute('toString')).toBe(false);
    expect(m.train.directionLabel('RV_VITCAT')).toBe('Viterbo → Catalano');
    expect(m.train.directionsForGtfsRouteShortName('romalido')).toEqual(['RL_CC-PSP', 'RL_PSP-CC']);
  });
});

// ---- GTFS-Realtime ---------------------------------------------------------------------------------------------
const rtpb = GtfsRealtimeBindings.transit_realtime;
const encode = (msg: GtfsRealtimeBindings.transit_realtime.IFeedMessage) => rtpb.FeedMessage.encode(rtpb.FeedMessage.create(msg)).finish();

describe('GTFS-Realtime', () => {
  it('captured real samples', () => {
    const u = m.rt.decodeTripUpdates(fs.readFileSync(path.join(FIX, 'trip_updates_sample.pb')), 0);
    expect(u.timestamp).toBe(1790930776);
    expect([...u.byTrip.keys()]).toEqual(['0#1640-11', '0#1621-10', '0#4575-10']);
    expect(u.byTrip.get('0#1640-11')!.stops[0]).toEqual({ stopId: '74024', sequence: 2, ts: 1790930780, delay: 72 });
    expect(u.byTrip.get('0#1621-10')!.stops[0]).toEqual({ stopId: '74008', sequence: 15, ts: 1790930852, delay: -82 });
    expect(u.byTrip.get('0#4575-10')!.route).toBe('451');
    expect(u.byTrip.get('0#1640-11')!.stops).toHaveLength(18);
    const v = m.rt.decodeVehicles(fs.readFileSync(path.join(FIX, 'vehicle_positions_sample.pb')));
    expect(v.vehicles).toHaveLength(5);
    expect([v.vehicles[0].id, v.vehicles[0].routeId, v.vehicles[0].tripId]).toEqual(['52', '409', '0#1640-11']);
    expect(v.vehicles[0].lat).toBeCloseTo(41.8686752, 5);
    expect(v.vehicles[0].lon).toBeCloseTo(12.5375986, 5);
  });

  it('cancellation (CANCELED / DELETED / SKIPPED), departure fallback, presence semantics', () => {
    const now = 1_800_000_000;
    const ev = (time: number, delay?: number) => (delay === undefined ? { time } : { time, delay });
    const buf = encode({
      header: { gtfsRealtimeVersion: '2.0', timestamp: now },
      entity: [
        { id: 'e1', tripUpdate: { trip: { tripId: 'T1', routeId: 'R1' }, stopTimeUpdate: [
          { stopSequence: 1, stopId: 'A', arrival: ev(now + 300, -86) },
          { stopSequence: 2, stopId: 'B', departure: ev(now + 600, 30) },
          { stopSequence: 3, stopId: 'C', arrival: ev(now + 700), scheduleRelationship: 1 },
          { stopSequence: 4, stopId: 'D', arrival: { delay: 5 }, departure: ev(now + 800) }, // arrival without time → skipped
          { stopSequence: 5, stopId: 'E', arrival: ev(now - 500) },
        ] } },
        { id: 'e2', tripUpdate: { trip: { tripId: 'T2', routeId: 'R2', scheduleRelationship: 3 }, stopTimeUpdate: [
          { stopId: 'A', arrival: ev(now + 350) }] } },
        { id: 'e3', tripUpdate: { trip: { routeId: 'R3', scheduleRelationship: 7 }, stopTimeUpdate: [
          { stopId: 'A', arrival: ev(now + 400) }] } },
        { id: 'e4', alert: {} },
      ],
    });
    const r = m.rt.decodeTripUpdates(buf, now);
    expect(r.timestamp).toBe(now);
    const a = r.byStop.get('A')!;
    expect(a.map((x) => [x.tripId, x.routeId, x.delay, x.cancelled])).toEqual([
      ['T1', 'R1', -86, false], ['T2', 'R2', null, true], ['e3', 'R3', null, true]]);
    expect([r.byStop.get('B')![0].ts, r.byStop.get('B')![0].delay]).toEqual([now + 600, 30]);
    expect(r.byStop.get('C')![0].cancelled).toBe(true);
    expect(r.byStop.has('D')).toBe(false);
    expect(r.byStop.has('E')).toBe(false);
    expect(r.byTrip.get('T1')!.stops).toHaveLength(4);
    expect(r.byTrip.get('T1')!.stops[0]).toEqual({ stopId: 'A', sequence: 1, ts: now + 300, delay: -86 });
    expect(r.byTrip.get('e3')!.stops[0].sequence).toBe(0); // absent stop_sequence → running index
  });

  it('vehicles: descriptor id, fallbacks, entities without position dropped', () => {
    const buf = encode({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 123 },
      entity: [
        { id: 'v1', vehicle: { trip: { tripId: 'T1', routeId: '409' }, position: { latitude: 41.9, longitude: 12.5, bearing: 90 }, vehicle: { id: '52' } } },
        { id: 'v2', vehicle: { position: { latitude: 41.8, longitude: 12.4 } } },
        { id: 'v3', vehicle: { trip: { tripId: 'T9' } } },
        { id: 'v4', tripUpdate: { trip: {} } },
      ],
    });
    const v = m.rt.decodeVehicles(buf);
    expect(v.timestamp).toBe(123);
    expect(v.vehicles).toHaveLength(2);
    expect(v.vehicles[0]).toMatchObject({ id: '52', routeId: '409', tripId: 'T1', bearing: 90 });
    expect(v.vehicles[0].lat).toBeCloseTo(41.9, 5);
    expect(v.vehicles[1]).toMatchObject({ id: 'v2', routeId: '', tripId: null, bearing: null });
  });

  it('a malformed entity is skipped, not fatal', () => {
    const good = encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: 5 }, entity: [
      { id: 'ok', vehicle: { position: { latitude: 1, longitude: 2 } } }] });
    // entity (field 2) whose only content is a vehicle with an empty Position (missing required lat/lon)
    const badEntity = Uint8Array.from([0x12, 0x07, 0x0a, 0x01, 0x78, 0x22, 0x02, 0x12, 0x00]);
    const v = m.rt.decodeVehicles(Buffer.concat([Buffer.from(good), Buffer.from(badEntity)]));
    expect(v.vehicles.map((x) => x.id)).toEqual(['ok']);
    expect(() => m.rt.decodeVehicles(Uint8Array.from([0x12, 0x50, 0x01]))).toThrow();
  });
});

// ---- Atac enrichment -------------------------------------------------------------------------------------------
describe('Atac static enrichment', () => {
  it('degrades gracefully without the GTFS database', () => {
    expect(m.atac.routesMeta(['1']).size).toBe(0);
    expect(m.atac.tripsMeta(['1']).size).toBe(0);
    expect(m.atac.stopNames(['1']).size).toBe(0);
    const out = m.atac.enrichVehicles({ timestamp: 99, vehicles: [
      { id: '52', lat: 41.868675231933594, lon: 12.5375986, bearing: null, routeId: '409', tripId: 'T1' },
      { id: 'v2', lat: 41.8, lon: 12.4, bearing: 90.04, routeId: '', tripId: null },
    ] });
    expect(out.updated).toBe(99);
    expect(out.vehicles[0]).toEqual({ id: 'atac-52', lat: 41.868675, lon: 12.537599, bearing: null, routeId: '409', routeLabel: '409',
      kind: 'bus', operator: 'Atac', tripId: 'T1', headsign: null });
    expect([out.vehicles[1].routeId, out.vehicles[1].routeLabel, out.vehicles[1].bearing, out.vehicles[1].headsign]).toEqual([null, null, 90, null]);
  });

  it('enriches from atac_routes / atac_trips / atac_stops when present', () => {
    const db = new Database(path.join(dataDir, 'madovai.sqlite'));
    db.exec(`CREATE TABLE atac_routes(route_id TEXT PRIMARY KEY, short_name, long_name, kind INT, operator TEXT, color TEXT, short_lc, long_lc);
      CREATE TABLE atac_trips(trip_id TEXT PRIMARY KEY, route_id, service_id, headsign TEXT);
      CREATE TABLE atac_stops(stop_id TEXT PRIMARY KEY, name, name_lc, lat REAL, lon REAL);
      INSERT INTO atac_routes VALUES ('MEA','','',1,'OP1',NULL,'',''), ('409','409','',3,'Roma TPL',NULL,'409',''), ('8','8','',0,'OP2',NULL,'','');
      INSERT INTO atac_trips VALUES ('T1','409','S','Tiburtina'), ('T2','MEA','S','');
      INSERT INTO atac_stops VALUES ('A','Piazza A','',0,0);`);
    db.close();
    const routes = m.atac.routesMeta(['MEA', '409', '8', 'nope']);
    expect(routes.get('MEA')).toEqual({ label: '', kind: 'metro', operator: 'Atac' });
    expect(routes.get('409')).toEqual({ label: '409', kind: 'bus', operator: 'Roma TPL' });
    expect(routes.get('8')).toEqual({ label: '8', kind: 'tram', operator: 'Roma TPL' });
    expect(m.atac.tripsMeta(['T1', 'T2']).get('T2')).toEqual({ route: 'MEA', headsign: null });
    const out = m.atac.enrichVehicles({ timestamp: 0, vehicles: [{ id: '1', lat: 1, lon: 2, bearing: 10.06, routeId: 'MEA', tripId: 'T1' }] });
    expect(out.vehicles[0]).toMatchObject({ routeLabel: 'MEA', kind: 'metro', operator: 'Atac', headsign: 'Tiburtina', bearing: 10.1 });
    expect(out.updated).toBeGreaterThan(1_700_000_000);
  });
});

// ---- departure status ------------------------------------------------------------------------------------------
describe('departureStatus', () => {
  const tr = (time: string, rit: number, mon: string, alive: boolean, sop = 'N') => ({
    tempoTransito: time, orarioPartenzaCorsa: time, ritardoSeconds: rit, monitorata: mon, vehicleAlive: alive, soppressa: sop,
  });
  const now = rome('2026-10-02T10:30:20');

  it('Cotral bus', () => {
    const { fromTransits } = m.dep;
    expect(fromTransits([tr('10:20', 0, '1', true), tr('10:45', 0, '0', false), tr('10:28', 300, '1', true)], now))
      .toEqual({ time: '10:33', delayMinutes: 5, isCancelled: false, nextUsefulTime: null });
    expect(fromTransits([tr('10:35', 300, '1', false)], now)).toEqual({ time: '10:35', delayMinutes: null, isCancelled: false, nextUsefulTime: null });
    expect(fromTransits([tr('10:35', 45, '1', true)], now)).toMatchObject({ time: '10:35', delayMinutes: 0 });
    expect(fromTransits([tr('10:40', -180, '1', true)], now)).toMatchObject({ time: '10:37', delayMinutes: 0 });
    expect(fromTransits([tr('10:40', 0, '0', false, 'Y'), tr('10:50', 0, '0', false)], now))
      .toEqual({ time: '10:40', delayMinutes: null, isCancelled: true, nextUsefulTime: '10:50' });
    expect(fromTransits([tr('10:40', 0, '0', false, 'Y')], now)!.nextUsefulTime).toBeNull();
    expect(fromTransits([tr('10:00', 0, '0', false)], now)).toBeNull();
    expect(fromTransits([tr('00:10', 0, '0', false)], rome('2026-10-02T23:50:00'))!.time).toBe('00:10');
  });

  it('ASTRAL and Atac', () => {
    const { fromAstral, fromAtac } = m.dep;
    expect(fromAstral([
      { id: 'a', time: '10:40', sortSeconds: 38400, delayMinutes: -3, isCancelled: true, isReplacementBus: false },
      { id: 'b', time: '11:10', sortSeconds: 40200, delayMinutes: 4, isCancelled: false, isReplacementBus: false },
    ])).toEqual({ time: '10:40', delayMinutes: 0, isCancelled: true, nextUsefulTime: '11:10' });
    expect(fromAstral([])).toBeNull();
    expect(fromAstral([{ id: 'a', time: '10:40', sortSeconds: 1, delayMinutes: null, isCancelled: false, isReplacementBus: false }])!.delayMinutes).toBeNull();

    const ts = Math.floor(rome('2026-10-02T10:45:30').getTime() / 1000);
    expect(fromAtac([{ ts, delaySeconds: 185, isCancelled: false }])).toEqual({ time: '10:45', delayMinutes: 3, isCancelled: false, nextUsefulTime: null });
    expect(fromAtac([{ ts, delaySeconds: null, isCancelled: true }, { ts: ts + 600, delaySeconds: 0, isCancelled: false }]))
      .toEqual({ time: '10:45', delayMinutes: null, isCancelled: true, nextUsefulTime: '10:55' });
    expect(fromAtac([{ ts, delaySeconds: -200, isCancelled: false }])!.delayMinutes).toBe(0);
    expect(fromAtac([])).toBeNull();
  });

  it('invalid reminders resolve to null (never throw)', async () => {
    const r = (source: unknown) => ({ id: 'x', stopName: 's', weekdays: [1], hour: 1, minute: 1, source }) as never;
    expect(await m.dep.departureStatus(r({ type: 'nope' }))).toBeNull();
    expect(await m.dep.departureStatus({} as never)).toBeNull();
    expect(await m.dep.departureStatus(r({ type: 'cotralTrain', route: 'BOGUS', stationName: 'x' }))).toBeNull();
    expect(await m.dep.departureStatus(r({ type: 'cotralBus', poleCode: 'a b' }))).toBeNull();
    expect(await m.dep.departureStatus(r({ type: 'atacStop', stopId: 'a b' }))).toBeNull();
  });

  it('cotralTrain via the ASTRAL stub', async () => {
    const s = await m.dep.departureStatus({ id: 'x', stopName: 'Acilia', weekdays: [1], hour: 1, minute: 1,
      source: { type: 'cotralTrain', stationName: 'Acilia', route: 'RL_PSP-CC' } }, rome('2026-10-02T23:57:00'));
    expect(s).toEqual({ time: '23:58', delayMinutes: null, isCancelled: true, nextUsefulTime: '23:59' });
  });
});

// ---- fan-out -----------------------------------------------------------------------------------------------------
describe('settleWithin', () => {
  it('skips failures and late results', async () => {
    const r = await m.fanout.settleWithin(['ok', 'fail', 'slow'], async (k) => {
      if (k === 'fail') throw new Error('x');
      if (k === 'slow') await new Promise((res) => setTimeout(res, 300));
      return k.toUpperCase();
    }, 100);
    expect([...r.entries()]).toEqual([['ok', 'OK']]);
  });
});

// ---- routes ------------------------------------------------------------------------------------------------------
describe('routes', () => {
  const realFetch = globalThis.fetch;
  const pole = fs.readFileSync(path.join(FIX, 'cotral_pole_1021.xml'));
  const tripPb = fs.readFileSync(path.join(FIX, 'trip_updates_sample.pb'));
  const vehPb = fs.readFileSync(path.join(FIX, 'vehicle_positions_sample.pb'));
  const upstream: string[] = [];
  let app: Awaited<ReturnType<typeof import('../src/app.js')['buildApp']>>;

  beforeAll(async () => {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      upstream.push(url);
      const ok = (body: BodyInit) => new Response(body, { status: 200 });
      if (url.includes('PIV.do') && url.includes('pCodice=1021')) return ok(pole);
      if (url.includes('PIV.do')) return ok('\r\n\r\n </transiti>\n\r\n');
      if (url.includes('Automezzi.do') && url.includes('pAutomezzo=6106')) return ok('<l><posizione pX="41.70 41.71" pY="12.90 12.91">x</posizione></l>');
      if (url.includes('Automezzi.do')) return ok('</listaPosizioni>');
      if (url.includes('trip_updates')) return ok(tripPb);
      if (url.includes('vehicle_positions')) return ok(vehPb);
      return realFetch(input, init);
    });
    m.cache.invalidate();
    app = await m.app.buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  const get = (url: string) => app.inject({ method: 'GET', url });

  it('cotral-transits (v1 + legacy alias, no-data reply, validation)', async () => {
    const res = await get('/api/v1/cotral-transits?pole=1021');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=5');
    const body = res.json();
    expect(body.pole.code).toBe('1021');
    expect(body.transits[0]).toMatchObject({ idCorsa: '11563486', tempoTransito: '10:56', vehicleCode: '6106', vehicleAlive: true });
    expect(Object.keys(body.transits[0])).toHaveLength(18);
    expect((await get('/api/cotral-transits.php?pole=1021')).json()).toEqual(body);
    expect((await get('/api/v1/cotral-transits?pole=ZZZ999')).json()).toEqual({ pole: null, transits: [] });
    expect((await get('/api/v1/cotral-transits?pole=a%20b')).statusCode).toBe(400);
    expect((await get('/api/v1/cotral-transits')).statusCode).toBe(400);
  });

  it('cotral-vehicle / cotral-vehicles', async () => {
    expect((await get('/api/v1/cotral-vehicle?code=6106')).json()).toEqual({ lat: 41.71, lon: 12.91 });
    expect((await get('/api/v1/cotral-vehicle?code=999')).json()).toEqual({ lat: null, lon: null });
    const v = (await get('/api/v1/cotral-vehicles?poles=1021, ZZZ999,1021')).json();
    expect(v.vehicles).toEqual([{ id: 'cotral-6106', code: '6106', lat: 41.71, lon: 12.91, routeId: 'CF952A', routeLabel: 'CF952A',
      kind: 'bus', delaySeconds: 358, tripId: '11563486' }]);
    expect((await get('/api/v1/cotral-vehicles')).json()).toEqual({ vehicles: [] });
    const many = Array.from({ length: 16 }, (_, i) => `p${i}`).join(',');
    expect((await get(`/api/v1/cotral-vehicles?poles=${many}`)).statusCode).toBe(400);
    expect((await get('/api/v1/cotral-vehicles?poles=a;b')).statusCode).toBe(400);
  });

  it('astral-line (stub): per-station next passage, failed station → next null', async () => {
    astralFailFermata = 'ff90004';
    const res = await get('/api/v1/astral-line?route=RL_PSP-CC');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.route).toBe('RL_PSP-CC');
    expect(body.lineName).toBe('Metromare');
    expect(body.directionLabel).toBe('Porta San Paolo → Cristoforo Colombo');
    expect(body.stations.map((s: { code: string }) => s.code)).toEqual(['ff90009', 'ff90001', 'ff90004']);
    expect(body.stations[2].next).toBeNull();
    expect((await get('/api/v1/astral-line?route=XX')).statusCode).toBe(400);
    astralFailFermata = '';
  });

  it('atac-vehicles / atac-live / atac-trip', async () => {
    const v = (await get('/api/atac-vehicles.php')).json();
    expect(v.vehicles).toHaveLength(5);
    expect(v.vehicles[0]).toMatchObject({ id: 'atac-52', routeId: '409', tripId: '0#1640-11', kind: 'bus', operator: 'Roma TPL' });

    const live = (await get('/api/v1/atac-live?stops=74024,nope')).json();
    expect(Object.keys(live.stops)).toEqual(['74024', 'nope']);
    expect(live.stops.nope).toEqual([]);
    expect(live.updated).toBe(1790930776);
    expect((await get('/api/v1/atac-live?stops=')).statusCode).toBe(400);
    const tooMany = Array.from({ length: 151 }, (_, i) => `s${i}`).join(',');
    expect((await get(`/api/v1/atac-live?stops=${tooMany}`)).statusCode).toBe(400);

    const trip = (await get(`/api/v1/atac-trip?trip=${encodeURIComponent('0#1640-11')}`)).json();
    expect(trip.tripId).toBe('0#1640-11');
    expect(trip.stops).toHaveLength(18);
    expect(trip.stops[0]).toEqual({ stopId: '74024', stopName: '74024', sequence: 2, ts: 1790930780, delaySeconds: 72 });
    const seqs = trip.stops.map((s: { sequence: number }) => s.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect((await get('/api/v1/atac-trip?trip=T1')).json()).toEqual({ tripId: 'T1', routeId: '409', routeLabel: '409', headsign: 'Tiburtina', stops: [] });
    expect((await get('/api/v1/atac-trip?trip=a%20b')).statusCode).toBe(400);
  });

  it('OpenAPI documents the live routes (v1 only)', async () => {
    const doc = app.swagger() as { paths: Record<string, unknown> };
    for (const p of ['cotral-transits', 'cotral-vehicle', 'cotral-vehicles', 'astral-line', 'atac-vehicles', 'atac-live', 'atac-trip']) {
      expect(doc.paths[`/api/v1/${p}`]).toBeDefined();
      expect(doc.paths[`/api/${p}.php`]).toBeUndefined();
    }
  });
});
