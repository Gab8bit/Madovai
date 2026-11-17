import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import { config, ROOT } from '../config.js';
import { cached } from '../lib/cache.js';
import { BadRequest, UpstreamError } from '../lib/errors.js';
import { romeParts } from '../lib/rome.js';
import type { Entry } from '../types.js';
import { isValidCode, parseIntStrict, secondsFromHHMM } from './cotral.js';
import { destinationName, directionLabel, isTrainRoute, lineName, type TrainRouteCode } from './cotralTrainRoute.js';
import { settleWithin } from './fanout.js';

/**
 * ASTRAL live rail schedules (gestionecorse.astralspa.it, public JSON). Port of Madovai-Web's AstralRepository.php
 * (AstralTrainClient + AstralTrainRepository on iOS). Station lists are tiny and stable (8 routes) and cached for
 * hours; per-station day schedules for 15 s; the per-line "next passage" view for 20 s.
 */

export const STATIONS_TTL_MS = 6 * 3600_000;
const STATIONS_STALE_MS = 48 * 3600_000;
export const TRANSIT_TTL_MS = 15_000;
const TRANSIT_STALE_MS = 60_000;
export const LINE_TTL_MS = 20_000;
const LINE_STALE_MS = 60_000;
const TIMEOUT_MS = 10_000;

export interface AstralStation {
  name: string;
  code: string;
  order: number;
}

export interface AstralDirection {
  destination: string;
  route: string;
  entries: Entry[];
}

export interface AstralLine {
  route: string;
  directionLabel: string;
  lineName: string;
  stations: (AstralStation & { next: Entry | null })[];
}

// ---- TLS ---------------------------------------------------------------------------------------------------------

/**
 * ASTRAL's TLS server sends an incomplete chain (leaf only, no Sectigo intermediate): browsers and iOS chase the AIA
 * link, Node/OpenSSL does not. The intermediate ships in certs/ (fingerprint + notes in certs/README.md) and is ADDED
 * to Node's root store for ASTRAL requests only — verification is never disabled.
 *
 * Node's global fetch bundles its own undici, which rejects a dispatcher from the npm `undici` package (different
 * major), so ASTRAL requests use the npm package's `fetch` together with its Agent.
 */
let agent: Agent | null = null;
function astralAgent(): Agent {
  if (!agent) {
    const ca: string[] = [...tls.rootCertificates];
    try {
      ca.push(fs.readFileSync(path.join(ROOT, 'certs', 'sectigo-ov-r36.pem'), 'utf8'));
    } catch {
      // Without the bundled intermediate the request fails with a TLS error (→ 502): never insecure.
    }
    agent = new Agent({ connect: { ca }, keepAliveTimeout: 10_000, connections: 16 });
  }
  return agent;
}

/** Only used by tests that point ASTRAL_BASE_URL at a local stub. */
function baseUrl(): string {
  return config.upstream.astralBase.replace(/\/+$/, '');
}

async function post(pathName: string, body: Record<string, string>, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const url = `${baseUrl()}/${pathName}`;
  let res;
  try {
    res = await undiciFetch(url, {
      method: 'POST',
      body: Object.keys(body).length === 0 ? '{}' : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'MadovaiBackend/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: url.startsWith('https:') ? astralAgent() : undefined,
    });
  } catch (err) {
    const e = err as Error;
    throw new UpstreamError(e.name === 'TimeoutError' ? 'timeout' : (e.cause as Error)?.message || e.message);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamError(`HTTP ${res.status}`, res.status);
  }
  const textBody = await res.text();
  try {
    return JSON.parse(textBody);
  } catch {
    throw new UpstreamError('Risposta ASTRAL non valida');
  }
}

// ---- parsing -----------------------------------------------------------------------------------------------------

/** PHP `(string)` of a JSON scalar. */
function str(v: unknown): string {
  if (v == null || v === false) return '';
  if (v === true) return '1';
  return typeof v === 'object' ? '' : String(v);
}

/** PHP `(int)` of a JSON scalar (leading integer, else 0). */
function int(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (v === true) return 1;
  const n = Number.parseInt(str(v).trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

const isRow = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

export function parseStations(data: unknown): AstralStation[] {
  if (!isRow(data)) throw new UpstreamError('Risposta ASTRAL non valida');
  const out: AstralStation[] = [];
  for (const row of Object.values(data)) {
    if (!isRow(row) || row.nomeFermata == null || row.codice == null || row.ordine == null) continue;
    out.push({ name: str(row.nomeFermata), code: str(row.codice), order: int(row.ordine) });
  }
  if (out.length === 0) throw new UpstreamError('Nessuna stazione ASTRAL');
  return out.sort((a, b) => a.order - b.order);
}

/**
 * ASTRAL's `ritardo` empty string = not computed yet (null), soppressa/busSostitutivo "Y" (trimmed, any case).
 * Entries whose `orario` isn't "H:MM" are dropped.
 */
export function parseTransits(data: unknown): Entry[] {
  if (!isRow(data)) throw new UpstreamError('Risposta ASTRAL non valida');
  const yes = (v: unknown) => str(v).replace(/^[ \t]+|[ \t]+$/g, '').toUpperCase() === 'Y';
  const out: Entry[] = [];
  for (const row of Object.values(data)) {
    if (!isRow(row)) continue;
    const time = str(row.orario);
    const seconds = secondsFromHHMM(time);
    if (seconds === null) continue;
    out.push({
      id: str(row.corsa),
      time,
      sortSeconds: seconds,
      delayMinutes: parseIntStrict(str(row.ritardo)),
      isCancelled: yes(row.soppressa),
      isReplacementBus: yes(row.busSostitutivo),
    });
  }
  return out;
}

/** Station code by name: exact match first (trimmed, lowercased), then substring in either direction. */
export function resolveFermata(stations: AstralStation[], stationName: string): string | null {
  const norm = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, '').toLowerCase();
  const target = norm(stationName);
  if (target === '') return null;
  for (const s of stations) if (norm(s.name) === target) return s.code;
  for (const s of stations) {
    const name = norm(s.name);
    if (name !== '' && (name.includes(target) || target.includes(name))) return s.code;
  }
  return null;
}

/** `[AstralDeparture].upcoming()`: entries not yet passed (sortSeconds ≥ now, Rome), soonest first. */
export function upcoming(entries: Entry[], nowSeconds = romeParts().secondsSinceMidnight): Entry[] {
  return entries.filter((e) => e.sortSeconds >= nowSeconds).sort((a, b) => a.sortSeconds - b.sortSeconds);
}

// ---- repository --------------------------------------------------------------------------------------------------

function assertRoute(route: string): asserts route is TrainRouteCode {
  if (!isTrainRoute(route)) throw new BadRequest('Percorso non valido');
}

/** All stations of one route, in physical order (cached 6 h, stale ≤ 48 h). */
export async function stations(route: string): Promise<AstralStation[]> {
  assertRoute(route);
  return cached(`astral:stations:${route}`, STATIONS_TTL_MS,
    async () => parseStations(await post(`fermate/${route}`, {})), STATIONS_STALE_MS);
}

/** One station's entire day for a route (cached 15 s, stale ≤ 60 s). */
export async function transitEntries(route: string, fermata: string, timeoutMs = TIMEOUT_MS): Promise<Entry[]> {
  assertRoute(route);
  if (!isValidCode(fermata)) throw new BadRequest('Fermata non valida');
  return cached(`astral:transit:${route}:${fermata}`, TRANSIT_TTL_MS,
    async () => parseTransits(await post('transit', { percorso: route, fermata }, timeoutMs)), TRANSIT_STALE_MS);
}

/**
 * The whole day's entries at `stationName` for `route`'s direction; null when the station can't be matched for this
 * route (not an error: the caller falls through to the next tier). Throws BadRequest for an unknown route and
 * UpstreamError when ASTRAL is unreachable with nothing cached.
 */
export async function astralDepartures(route: string, stationName: string): Promise<AstralDirection | null> {
  assertRoute(route);
  const fermata = resolveFermata(await stations(route), stationName);
  if (fermata === null) return null;
  return {
    destination: destinationName(route),
    route,
    entries: await transitEntries(route, fermata),
  };
}

/**
 * Per-station "next passage" for a line (astral-line): one /api/transit per station, concurrently, within ~10 s.
 * A station whose call fails gets `next: null`. Cached 20 s.
 */
export async function astralLine(route: string): Promise<AstralLine> {
  assertRoute(route);
  return cached(`astral:line:${route}`, LINE_TTL_MS, async () => {
    const list = await stations(route);
    const byCode = await settleWithin([...new Set(list.map((s) => s.code))],
      (code) => transitEntries(route, code, TIMEOUT_MS), TIMEOUT_MS);
    const now = romeParts().secondsSinceMidnight;
    return {
      route,
      directionLabel: directionLabel(route),
      lineName: lineName(route),
      stations: list.map((s) => {
        const entries = byCode.get(s.code);
        return { name: s.name, code: s.code, order: s.order, next: entries ? (upcoming(entries, now)[0] ?? null) : null };
      }),
    };
  }, LINE_STALE_MS);
}
