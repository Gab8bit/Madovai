import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { config } from '../config.js';
import { cached } from '../lib/cache.js';
import { BadRequest } from '../lib/errors.js';
import { fetchBuffer } from '../lib/http.js';

/**
 * Cotral's internal live endpoint (PIV.do / Automezzi.do), plain HTTP + XML.
 * Port of Madovai-Web's CotralClient.php + CotralXml.php + CotralTime.php (themselves ports of the iOS
 * CotralXMLClient / TransitsRepository / VehicleRepository / CotralTimeUtils).
 */

export const TRANSITS_TTL_MS = 8_000;
export const TRANSITS_STALE_MS = 30_000;
export const POSITION_TTL_MS = 5_000;
export const POSITION_STALE_MS = 20_000;
const TIMEOUT_MS = 10_000;

export interface CotralPole {
  code: string;
  name: string;
  stopName: string;
  locality: string;
  comune: string;
  lat: number;
  lon: number;
}

export interface Transit {
  idCorsa: string;
  percorso: string;
  partenzaCorsa: string;
  orarioPartenzaCorsa: string;
  arrivoCorsa: string;
  orarioArrivoCorsa: string;
  soppressa: string;
  numeroOrdine: string;
  tempoTransito: string;
  ritardoSeconds: number;
  passato: string;
  vehicleCode: string | null;
  vehicleAlive: boolean;
  testoFermata: string;
  instradamento: string;
  banchina: string;
  monitorata: string;
  accessibile: string;
}

export interface TransitsResult {
  pole: CotralPole;
  transits: Transit[];
}

export interface LatLon { lat: number; lon: number }

// ---- time & parsing helpers (CotralTime.php) ---------------------------------------------------------------------

/** Swift `Int(s.trimmingCharacters(in: .whitespaces))`: strict base-10 integer or null. */
export function parseIntStrict(s: string): number | null {
  const t = s.replace(/^[ \t]+|[ \t]+$/g, '');
  return /^[+-]?\d{1,18}$/.test(t) ? Number.parseInt(t, 10) : null;
}

/** Swift `Double(s)`: strict decimal number or null. */
export function parseDoubleStrict(s: string): number | null {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number.parseFloat(s) : null;
}

/**
 * Cotral gives integer seconds; the apps show "HH:MM" (optionally "-HH:MM").
 * `wrapClockAt24` = true for times of day (24:48 → 00:48), false for durations. Unparseable → "00:00".
 */
export function readableTime(raw: string, wrapClockAt24 = true): string {
  const seconds = parseIntStrict(raw);
  if (seconds === null) return '00:00';
  const sign = seconds < 0 ? '-' : '';
  const totalMinutes = Math.floor(Math.abs(seconds) / 60);
  let hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (wrapClockAt24) hours %= 24;
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Cotral's cmd=1 has lat/lon swapped for many poles (Lazio: lat ~41-43, lon ~11-14). */
export function normalizeLatLon(lat: number, lon: number): [number, number] {
  return lat > 0 && lat < 20 && lon > 20 ? [lon, lat] : [lat, lon];
}

/** "HH:MM" → seconds since midnight (hours may exceed 23), null if malformed. */
export function secondsFromHHMM(time: string): number | null {
  const m = /^(\d+):(\d+)$/.exec(time);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
}

/** Pole/vehicle/stop codes accepted from the outside world: never forwarded as free-form text. */
export const CODE_PATTERN = '^[A-Za-z0-9_.:-]{1,64}$';
const CODE_RE = new RegExp(CODE_PATTERN);
export function isValidCode(s: string): boolean {
  return CODE_RE.test(s);
}

// ---- XML (CotralXml.php) -----------------------------------------------------------------------------------------

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name) => name === 'corsa' || name === 'posizione',
});

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** PHP's trim() default set. */
export function trimText(s: string): string {
  return s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

/** Body bytes → text: strict UTF-8, falling back to Latin-1 instead of dropping a whole pole over one stray byte. */
export function decodeBody(body: Buffer | string): string {
  if (typeof body === 'string') return body;
  try {
    return utf8.decode(body);
  } catch {
    return body.toString('latin1');
  }
}

/**
 * Cotral sometimes answers with just a dangling closing tag (e.g. "</transiti>") for an unknown/no-data query, or an
 * empty body: both mean "no data" (null), as does an unparseable document. Returns the root element.
 */
export function parseXml(body: Buffer | string): XmlNode | null {
  const trimmed = trimText(decodeBody(body).replace(/^﻿/, ''));
  if (trimmed === '') return null;
  if (/^<\/[A-Za-z][\w:.-]*>$/.test(trimmed)) return null;
  if (XMLValidator.validate(trimmed) !== true) return null;
  let doc: XmlNode;
  try {
    doc = parser.parse(trimmed) as XmlNode;
  } catch {
    return null;
  }
  const rootKey = Object.keys(doc).find((k) => !k.startsWith('?') && !k.startsWith('#'));
  if (!rootKey) return null;
  const root = first(doc[rootKey]);
  // An empty root (<transiti/>) parses to "": treat it as an element without children.
  return root !== null && typeof root === 'object' ? (root as XmlNode) : {};
}

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

/** Direct text of an element value as produced by the parser. */
function nodeText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const t = (v as XmlNode)['#text'];
    return t == null ? '' : String(t);
  }
  return String(v);
}

/** Trimmed text of the first child `tag`, or '' (Cotral's fields are consistently non-optional strings). */
function text(node: XmlNode, tag: string): string {
  return trimText(nodeText(first(node[tag])));
}

function attr(v: unknown, name: string): string {
  return v !== null && typeof v === 'object' ? String((v as XmlNode)[`@_${name}`] ?? '') : '';
}

// ---- transits ----------------------------------------------------------------------------------------------------

function apiUrl(endpoint: string, params: Record<string, string>): string {
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${config.upstream.cotralBase}/${endpoint}?${qs}`;
}

export function transitsUrl(poleCode: string): string {
  return apiUrl('PIV.do', {
    cmd: '1',
    userId: config.upstream.cotralUserId,
    pCodice: poleCode,
    pFormato: 'xml',
    pDelta: config.upstream.cotralDelta,
  });
}

export function positionUrl(vehicleCode: string): string {
  return apiUrl('Automezzi.do', {
    cmd: 'loc',
    userId: config.upstream.cotralUserId,
    pAutomezzo: vehicleCode,
    pFormato: 'xml',
  });
}

export function parseTransits(body: Buffer | string): TransitsResult | null {
  const root = parseXml(body);
  if (root === null || root.palina === undefined) return null;
  const corse = (Array.isArray(root.corsa) ? root.corsa : root.corsa === undefined ? [] : [root.corsa]) as unknown[];
  if (corse.length === 0) return null;

  const p = asNode(first(root.palina));
  const rawLat = parseDoubleStrict(text(p, 'latitudine')) ?? 0;
  const rawLon = parseDoubleStrict(text(p, 'longitudine')) ?? 0;
  const [lat, lon] = normalizeLatLon(rawLat, rawLon);

  return {
    pole: {
      code: text(p, 'codice'),
      name: text(p, 'nomePalina'),
      stopName: text(p, 'nomeStop'),
      locality: text(p, 'localita'),
      comune: text(p, 'comune'),
      lat,
      lon,
    },
    transits: corse.map((c) => makeTransit(asNode(c))),
  };
}

function asNode(v: unknown): XmlNode {
  return v !== null && typeof v === 'object' ? (v as XmlNode) : {};
}

function makeTransit(n: XmlNode): Transit {
  let vehicleCode: string | null = null;
  let alive = false;
  if (n.automezzo !== undefined) {
    const a = first(n.automezzo);
    const code = trimText(nodeText(a));
    vehicleCode = code === '' ? null : code;
    alive = attr(a, 'isAlive') === '1';
  }
  return {
    idCorsa: text(n, 'idCorsa'),
    percorso: text(n, 'percorso'),
    partenzaCorsa: text(n, 'partenzaCorsa'),
    orarioPartenzaCorsa: readableTime(text(n, 'orarioPartenzaCorsa')),
    arrivoCorsa: text(n, 'arrivoCorsa'),
    orarioArrivoCorsa: readableTime(text(n, 'orarioArrivoCorsa')),
    soppressa: text(n, 'soppressa'),
    numeroOrdine: text(n, 'numeroOrdine'),
    tempoTransito: readableTime(text(n, 'tempoTransito')),
    // raw seconds, NOT wrapped (negative = ahead of schedule)
    ritardoSeconds: parseIntStrict(text(n, 'ritardo')) ?? 0,
    passato: text(n, 'passato'),
    vehicleCode,
    vehicleAlive: alive,
    testoFermata: text(n, 'testoFermata'),
    instradamento: text(n, 'instradamento'),
    banchina: text(n, 'banchina'),
    monitorata: text(n, 'monitorata'),
    accessibile: text(n, 'accessibile'),
  };
}

/** Transit.trackingStatus == .realtime: monitored AND the vehicle is transmitting. */
export function isDelayReliable(t: Pick<Transit, 'monitorata' | 'vehicleAlive'>): boolean {
  return t.monitorata === '1' && t.vehicleAlive === true;
}

/** Transit.canTrackVehicle. */
export function canTrackVehicle(t: Pick<Transit, 'monitorata' | 'vehicleCode'>): boolean {
  return t.monitorata === '1' && (t.vehicleCode ?? '') !== '';
}

export const transitsKey = (poleCode: string) => `cotral:transits:${poleCode}`;
export const positionKey = (vehicleCode: string) => `cotral:pos:${vehicleCode}`;

/**
 * Live transits for a pole, or null when Cotral has no data (dangling tag / empty / no `corsa`).
 * Cached 8 s per pole (single-flight, stale ≤ 30 s on error). Throws UpstreamError when unreachable and nothing cached.
 */
export async function transits(poleCode: string, timeoutMs = TIMEOUT_MS): Promise<TransitsResult | null> {
  if (!isValidCode(poleCode)) throw new BadRequest('Codice palina non valido');
  return cached(transitsKey(poleCode), TRANSITS_TTL_MS,
    async () => parseTransits(await fetchBuffer(transitsUrl(poleCode), { timeoutMs })), TRANSITS_STALE_MS);
}

// ---- vehicle position --------------------------------------------------------------------------------------------

/**
 * First `posizione`, last element of its pX / pY trail (VehiclePosition.latestCoordinate):
 * null when unparseable or the (0,0) "no fix" placeholder.
 */
export function parsePosition(body: Buffer | string): LatLon | null {
  const root = parseXml(body);
  if (root === null || root.posizione === undefined) return null;
  const node = first(root.posizione);
  const xs = attr(node, 'pX').split(' ').filter((s) => s !== '');
  const ys = attr(node, 'pY').split(' ').filter((s) => s !== '');
  if (xs.length === 0 || ys.length === 0) return null;
  const lat = parseDoubleStrict(xs[xs.length - 1]);
  const lon = parseDoubleStrict(ys[ys.length - 1]);
  if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** Latest known position of a vehicle, null if none/invalid. Cached 5 s per code (stale ≤ 20 s on error). */
export async function vehiclePosition(vehicleCode: string, timeoutMs = TIMEOUT_MS): Promise<LatLon | null> {
  if (!isValidCode(vehicleCode)) throw new BadRequest('Codice veicolo non valido');
  return cached(positionKey(vehicleCode), POSITION_TTL_MS,
    async () => parsePosition(await fetchBuffer(positionUrl(vehicleCode), { timeoutMs })), POSITION_STALE_MS);
}
