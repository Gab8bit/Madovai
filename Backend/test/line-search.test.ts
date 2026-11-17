import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalize, parseQuery, rank } from '../src/gtfs/search.js';

/**
 * /line in route order and the ranked /search, on the mini feeds in test/fixtures/gtfs-line-search:
 *  - MEB: metro, two directions with separate platforms; one trip's stop_times rows out of sequence order and split
 *    in two blocks (the builder must sort and merge them);
 *  - 90: bus, two directions; direction 0 has two 4-stop variants, the one with the more frequent shape wins and the
 *    other variant's stop is placed next to its predecessor;
 *  - C2: trunk + a branch + a trip starting from a stop off the trunk;
 *  - Cotral 500: bus with two directions sharing poles (direction 1 adds a stop).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FEEDS = path.join(here, 'fixtures', 'gtfs-line-search');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'madovai-line-search-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.GTFS_REBUILD_AT = '';
process.env.REMINDERS_ENABLED = '0';

let app: FastifyInstance;
let dbFile: string;

beforeAll(async () => {
  const build = await import('../src/gtfs/build.js');
  await build.runBuild({ dataDir: process.env.DATA_DIR!, fromDir: FEEDS, log: () => {} });
  dbFile = path.join(process.env.DATA_DIR!, 'madovai.sqlite');
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
  return { status: res.statusCode, body: res.json() };
};
const ids = (list: Array<{ id: string }>) => list.map((x) => x.id);

// ---------------------------------------------------------------------------------------------- /line

describe('line: stops in route order', () => {
  it('metro: the real station order, direction 0 then direction 1 (rows out of order and split are merged)', async () => {
    const { body } = await get('/api/v1/line?source=atac&id=MEB');
    expect(ids(body.stops)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'R4', 'R3', 'R2', 'R1', 'R0']);
    expect(body.stops.map((s: { name: string }) => s.name)).toEqual([
      'Laurentina', 'Eur Fermi', 'Piramide', 'Termini', 'Rebibbia', 'Rebibbia', 'Termini', 'Piramide', 'Eur Fermi', 'Laurentina',
    ]);
    expect(body.directions).toEqual([
      { directionId: 0, headsign: 'Rebibbia', stopIds: ['L0', 'L1', 'L2', 'L3', 'L4'] },
      { directionId: 1, headsign: 'Laurentina', stopIds: ['R4', 'R3', 'R2', 'R1', 'R0'] },
    ]);
    expect(body.route).toMatchObject({ id: 'MEB', displayName: 'Metro B', kind: 'metro' });
  });

  it('bus with two directions: representative by most frequent shape, the other variant next to its predecessor', async () => {
    const { body } = await get('/api/v1/line?source=atac&id=90');
    expect(ids(body.stops)).toEqual(['A1', 'B1', 'X1', 'Y1', 'C1', 'C2', 'B2', 'A2']);
    expect(body.directions).toEqual([
      { directionId: 0, headsign: 'Arrivo', stopIds: ['A1', 'B1', 'Y1', 'C1'] },
      { directionId: 1, headsign: 'Zeta', stopIds: ['C2', 'B2', 'A2'] },
    ]);
  });

  it('branch: the branch after the fork, a trip starting off the trunk before its first trunk stop', async () => {
    const { body } = await get('/api/v1/line?source=atac&id=C2');
    expect(ids(body.stops)).toEqual(['P1', 'S0', 'P2', 'Q3', 'P3', 'P4']);
    expect(body.directions).toEqual([{ directionId: 0, headsign: 'Tronco 4', stopIds: ['P1', 'P2', 'P3', 'P4'] }]);
  });

  it('Cotral bus: route order too (was by stop id), stops only in direction 1 appended', async () => {
    const { body } = await get('/api/v1/line?source=cotral&id=500');
    expect(ids(body.stops)).toEqual(['f3', 'f1', 'f2', 'f4']);
    expect(body.stops[0]).toEqual({ id: 'f3', name: 'VELLETRI | Stazione FS', lat: 41.68, lon: 12.77, headsign: null });
    expect(body.directions).toEqual([
      { directionId: 0, headsign: null, stopIds: ['f3', 'f1', 'f2'] },
      { directionId: 1, headsign: null, stopIds: ['f2', 'f1', 'f4', 'f3'] },
    ]);
    expect(body.shapes).toEqual([]);
  });

  it('Cotral rail is untouched (longest trip, no directions)', async () => {
    const { body } = await get('/api/v1/line?source=cotral&id=F:ROMALIDO');
    expect(ids(body.stops)).toEqual(['RL_PORTASPAOLO', 'RL_ACILIA', 'RL_COLOMBO']);
    expect(body).not.toHaveProperty('directions');
  });

  it('same stops (count, fields, headsign) as the old alphabetical list, for every line', async () => {
    const db = new Database(dbFile, { readonly: true });
    const old = db.prepare(
      `SELECT s.stop_id AS id, s.name, s.lat, s.lon, h.headsign FROM atac_stop_routes sr JOIN atac_stops s ON s.stop_id = sr.stop_id
       LEFT JOIN atac_stop_headsign h ON h.route_id = sr.route_id AND h.stop_id = sr.stop_id WHERE sr.route_id = ? ORDER BY s.name, s.stop_id`,
    );
    const oldCotral = db.prepare(
      'SELECT s.stop_id AS id FROM cotral_stop_routes sr JOIN cotral_stops s ON s.stop_id = sr.stop_id WHERE sr.route_id = ? ORDER BY s.stop_id',
    );
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    for (const id of db.prepare('SELECT route_id FROM atac_routes').pluck().all() as string[]) {
      const { body } = await get(`/api/v1/line?source=atac&id=${encodeURIComponent(id)}`);
      const before = (old.all(id) as Array<{ id: string; headsign: string | null }>).map((r) => ({ ...r, headsign: r.headsign ?? null }));
      expect([...body.stops].sort(byId)).toEqual(before.sort(byId));
      expect(new Set(ids(body.stops)).size).toBe(body.stops.length); // no duplicates
    }
    for (const id of db.prepare('SELECT route_id FROM cotral_routes WHERE is_rail = 0').pluck().all() as string[]) {
      const { body } = await get(`/api/v1/line?source=cotral&id=${encodeURIComponent(id)}`);
      expect([...ids(body.stops)].sort()).toEqual((oldCotral.all(id) as Array<{ id: string }>).map((r) => r.id).sort());
    }
    db.close();
  });

  it('legacy alias: identical JSON', async () => {
    for (const q of ['source=atac&id=MEB', 'source=atac&id=C2', 'source=cotral&id=500']) {
      expect((await get(`/api/line.php?${q}`)).body).toEqual((await get(`/api/v1/line?${q}`)).body);
    }
  });

  it('a database built before schema 2 still answers (alphabetical, no directions) and is flagged for rebuild', async () => {
    const copy = path.join(tmp, 'old.sqlite');
    fs.copyFileSync(dbFile, copy);
    const db = new Database(copy);
    db.exec("DROP TABLE atac_route_stops; DROP TABLE atac_route_directions; DROP TABLE cotral_route_stops; DROP TABLE cotral_route_directions; UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    const { Store } = await import('../src/gtfs/store.js');
    const line = new Store(db).line('atac', 'MEB');
    expect(ids(line.stops)).toEqual(['L1', 'R1', 'L0', 'R0', 'L2', 'R2', 'L4', 'R4', 'L3', 'R3']);
    expect(line.directions).toBeUndefined();
    expect(ids(new Store(db).line('cotral', '500').stops)).toEqual(['f1', 'f2', 'f3', 'f4']);
    db.close();
    const { SCHEMA_VERSION } = await import('../src/gtfs/builder.js');
    const { gtfsSchemaVersion } = await import('../src/db.js');
    expect(SCHEMA_VERSION).toBe(2);
    expect(gtfsSchemaVersion()).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------- /search

describe('search: normalized, every word, ranked', () => {
  const search = async (q: string) => (await get(`/api/v1/search?q=${encodeURIComponent(q)}`)).body;

  it('normalizes case, accents, punctuation and spaces', () => {
    expect(normalize('ROMA | Termini FS (Piazza Cinquecento)')).toBe('roma termini fs piazza cinquecento');
    expect(normalize("  Città,  dell'Aquila / P.zza-Duomo ")).toBe('citta dell aquila p zza duomo');
    expect(parseQuery('|/-.,()')).toBeNull();
    expect(parseQuery('metro  metro a')).toEqual({ text: 'metro metro a', words: ['metro', 'a'] });
    const q = parseQuery('metro a')!;
    expect(rank('metro a', q)).toBe(0);
    expect(rank('metro a carnevale', q)).toBe(1);
    expect(rank('cornelia metro a', q)).toBe(2);
    expect(rank('america metro b', q)).toBe(3);
    expect(rank('metromare', q)).toBe(4);
    expect(rank('linea b', q)).toBe(-1);
  });

  it('"Metro A" finds the MEA line first (displayName), before lines that only mention it', async () => {
    const r = await search('Metro A');
    expect(ids(r.routes)).toEqual(['MEA', '502', 'F:ROMALIDO']);
    expect(r.routes[0]).toEqual({ source: 'atac', id: 'MEA', shortName: 'MEA', longName: '', displayName: 'Metro A', kind: 'metro', operator: 'Atac', color: 'E85C1F', rail: false });
    // stops: the whole phrase at a word start ranks above scattered words ("AMERICA METRO B")
    expect(ids(r.stops)).toEqual(['AN1', 'f2', 'AN2', 'AM1']);
    expect((await search('metro b1')).routes).toEqual([]);
  });

  it('"64": line 64 before 640 and 664 (Atac and Cotral merged by rank)', async () => {
    expect(ids((await search('64')).routes)).toEqual(['64', '640', '664', '501']);
  });

  it('several words in any order', async () => {
    const r = await search('anagnina metro');
    expect(ids(r.stops)).toEqual(['AN1', 'f2', 'AN2']);
    expect(r.stops.map((s: { name: string }) => s.name)).toContain('STAZIONE METRO ANAGNINA METRO A');
    expect(r.stops.find((s: { id: string }) => s.id === 'AN1')).toEqual({ source: 'atac', id: 'AN1', name: 'ANAGNINA METRO A', lat: 41.84, lon: 12.59, rail: false, metro: true });
    expect(r.stops.find((s: { id: string }) => s.id === 'AN2').metro).toBe(false);
    expect(ids((await search('metro anagnina')).stops)).toEqual(['AN2', 'AN1', 'f2']);
  });

  it('punctuation in names is ignored: "roma termini" finds "ROMA | Termini FS (…)"', async () => {
    const r = await search('roma termini');
    expect(ids(r.stops)).toEqual(['f6', 'f5']);
    expect(r.stops[1]).toEqual({ source: 'cotral', id: 'f5', name: 'ROMA | Termini FS (Piazza Cinquecento)', lat: 41.9, lon: 12.5, rail: false });
    expect(ids((await search('piazza   venezia')).stops)).toEqual(['VE1']);
  });

  it('accents: "città" = "CITTA\'" = "CITTÀ"', async () => {
    const r = await search('città');
    expect(ids(r.stops)).toEqual(['f8', 'CI1']);
    expect(ids(r.routes)).toEqual(['502']);
    expect(await search('CITTA')).toEqual(r);
  });

  it('one or two letters: ranked, limits unchanged (15 + 15 stops, 10 + 10 lines)', async () => {
    const one = await search('a');
    expect(one.stops.filter((s: { source: string }) => s.source === 'cotral').length).toBeLessThanOrEqual(15);
    expect(one.stops.filter((s: { source: string }) => s.source === 'atac')).toHaveLength(15);
    expect(one.routes.filter((x: { source: string }) => x.source === 'atac').length).toBeLessThanOrEqual(10);
    const two = await search('me');
    expect(ids(two.routes).slice(0, 2)).toEqual(['MEA', 'MEB']);
  });

  it('only punctuation or empty: empty lists; legacy alias identical', async () => {
    for (const q of ['|/-.', '%', '   ', '']) expect(await search(q)).toEqual({ stops: [], routes: [] });
    expect((await get('/api/search.php?q=Metro%20A')).body).toEqual(await search('Metro A'));
  });
});
