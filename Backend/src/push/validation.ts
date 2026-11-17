import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { BadRequest } from '../lib/errors.js';
import type { Device, Reminder, ReminderSource } from '../types.js';
import { pushSettings } from './settings.js';

/**
 * Strict validation/normalisation of everything a client sends to the push endpoints.
 * A literal port of Madovai-Web's src/Push/Validator.php (same rules, same Italian messages), extended with
 * the FCM and APNs device types.
 */

export const MAX_REMINDERS = 30;
export const MAX_ENDPOINT = 600;
export const TRAIN_ROUTES = ['RL_CC-PSP', 'RL_PSP-CC', 'RN_RMMON', 'RN_MONRM', 'RV_CATVIT', 'RV_VITCAT', 'RV_MORCAT', 'RV_CATMOR'] as const;

export type WebPushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/** JSON objects AND arrays (PHP `is_array` on a decoded body accepts both). */
const isArrayLike = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const get = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

// ---------------------------------------------------------------- base64url / P-256

/** Strict base64url decode (RFC 4648 §5): url-safe alphabet only, optional "=" padding; null when malformed. */
export function b64urlDecode(s: string): Buffer | null {
  if (s === '' || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
  const t = s.replace(/=+$/, '');
  if (t.length % 4 === 1) return null;
  return Buffer.from(t, 'base64url');
}

/** True for a 65-byte uncompressed point that lies on P-256. */
export function isP256Point(raw: Buffer): boolean {
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  try {
    crypto.ECDH.convertKey(raw, 'prime256v1', undefined, undefined, 'uncompressed');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Web Push endpoint

/**
 * Subscription endpoint rules: https, <=600 chars, port 443, no credentials, no fragment,
 * a real DNS name (no IP literals, localhost, single-label or internal TLDs).
 * Keeps the server from being used as a blind-request proxy to internal hosts.
 */
export function endpointError(endpoint: string): string | null {
  if (endpoint === '' || Buffer.byteLength(endpoint) > MAX_ENDPOINT) return 'endpoint mancante o troppo lungo';
  if (/[\x00-\x20\x7f]/.test(endpoint)) return 'endpoint non valido';
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(endpoint);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'endpoint non valido';
  }
  if (!m || m[2] === '' || m[2].includes('@') || endpoint.includes('#') || url.hostname === '') return 'endpoint non valido';
  const scheme = m[1].toLowerCase();
  if (pushSettings.allowInsecure) return scheme === 'http' || scheme === 'https' ? null : 'endpoint non valido';
  if (scheme !== 'https') return 'endpoint deve essere https';
  if (url.port !== '' && url.port !== '443') return 'endpoint con porta non consentita';
  return hostError(url.hostname);
}

function hostError(rawHost: string): string | null {
  const host = rawHost.toLowerCase().replace(/^\[+|\]+$/g, '');
  if (net.isIP(host) !== 0 || host.includes(':')) return 'endpoint con IP non consentito';
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]+$/.test(host)
    || /\.(local|localhost|internal|lan|home|corp|test|invalid|example)$/.test(host)) {
    return 'endpoint host non consentito';
  }
  return null;
}

/** Private, loopback, link-local, CGNAT, documentation, multicast and other reserved addresses. */
export function isNonPublicIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isNonPublicIp(mapped[1]);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff') || s.startsWith('2001:db8:') || s.startsWith('64:ff9b:');
  }
  return true;
}

/**
 * Send-time guard (defence in depth): same URL rules + the host must not resolve to a private/reserved address.
 * Unresolvable hosts pass (the request then fails by itself), as in PHP.
 */
export async function pushHostAllowed(endpoint: string): Promise<boolean> {
  if (endpointError(endpoint) !== null) return false;
  if (pushSettings.allowInsecure) return true;
  let ips: { address: string }[] = [];
  try {
    ips = await dns.lookup(new URL(endpoint).hostname, { all: true });
  } catch {
    return true;
  }
  return ips.every((r) => !isNonPublicIp(r.address));
}

// ---------------------------------------------------------------- devices

/** `subscription` object of a Web Push device (PHP Validator::subscription). */
export function validateSubscription(sub: unknown, needKeys = true): WebPushSubscription {
  if (!isArrayLike(sub)) throw new BadRequest('subscription mancante');
  const endpoint = get(sub, 'endpoint');
  if (typeof endpoint !== 'string') throw new BadRequest('subscription.endpoint mancante');
  const e = endpointError(endpoint);
  if (e !== null) throw new BadRequest(e);
  if (!needKeys) return { endpoint, keys: { p256dh: '', auth: '' } };
  const keys = get(sub, 'keys');
  const p256dh = isArrayLike(keys) ? get(keys, 'p256dh') : undefined;
  const auth = isArrayLike(keys) ? get(keys, 'auth') : undefined;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') throw new BadRequest('subscription.keys mancanti');
  const ua = b64urlDecode(p256dh);
  if (ua === null || ua.length !== 65 || p256dh.includes('=') || !isP256Point(ua)) throw new BadRequest('keys.p256dh non valida');
  const secret = b64urlDecode(auth);
  if (secret === null || secret.length !== 16 || auth.includes('=')) throw new BadRequest('keys.auth non valida');
  return { endpoint, keys: { p256dh, auth } };
}

/** FCM registration tokens: opaque, url-safe, in practice ~150-180 chars. */
export const FCM_TOKEN_RE = /^[A-Za-z0-9_:-]{100,4096}$/;
/** APNs device tokens: 32 bytes as hex. */
export const APNS_TOKEN_RE = /^[0-9a-fA-F]{64}$/;

/**
 * `device` object: {"type":"webpush","subscription":{…}} | {"type":"fcm","token"} | {"type":"apns","token","environment"}.
 * `needKeys = false` (unsubscribe) only needs what identifies the device (endpoint / token).
 * Returns a normalised copy (unknown keys dropped, APNs token lower-cased, environment defaulted).
 */
export function validateDevice(d: unknown, needKeys = true): Device {
  if (!isArrayLike(d)) throw new BadRequest('device mancante');
  const type = get(d, 'type');
  if (type === 'webpush') return { type, subscription: validateSubscription(get(d, 'subscription'), needKeys) };
  if (type === 'fcm') {
    const token = get(d, 'token');
    if (typeof token !== 'string') throw new BadRequest('device.token mancante');
    if (!FCM_TOKEN_RE.test(token)) throw new BadRequest('device.token non valido');
    return { type, token };
  }
  if (type === 'apns') {
    const token = get(d, 'token');
    if (typeof token !== 'string') throw new BadRequest('device.token mancante');
    if (!APNS_TOKEN_RE.test(token)) throw new BadRequest('device.token non valido');
    const env = get(d, 'environment') ?? (config.apns.production ? 'production' : 'sandbox');
    if (env !== 'sandbox' && env !== 'production') throw new BadRequest('device.environment non valido');
    return { type, token: token.toLowerCase(), environment: env };
  }
  throw new BadRequest('device.type non valido');
}

// ---------------------------------------------------------------- reminders

/** `reminders` array: max 30, ids unique. An empty JSON object counts as an empty list (PHP decodes both to []). */
export function validateReminders(list: unknown): Reminder[] {
  let items: unknown[];
  if (Array.isArray(list)) items = list;
  else if (isArrayLike(list) && Object.keys(list).length === 0) items = [];
  else throw new BadRequest('reminders deve essere un array');
  if (items.length > MAX_REMINDERS) throw new BadRequest(`Troppi promemoria (max ${MAX_REMINDERS})`);
  const seen = new Set<string>();
  return items.map((r) => {
    const n = validateReminder(r);
    if (seen.has(n.id)) throw new BadRequest('id promemoria duplicato');
    seen.add(n.id);
    return n;
  });
}

export function validateReminder(r: unknown): Reminder {
  if (!isArrayLike(r)) throw new BadRequest('promemoria non valido');
  const id = get(r, 'id');
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new BadRequest('promemoria.id non valido');
  const stopName = text(get(r, 'stopName'), 120, 'stopName');
  const hour = get(r, 'hour');
  const minute = get(r, 'minute');
  if (!isInt(hour) || hour < 0 || hour > 23) throw new BadRequest('hour deve essere 0-23');
  if (!isInt(minute) || minute < 0 || minute > 59) throw new BadRequest('minute deve essere 0-59');
  const wd = get(r, 'weekdays');
  const values = Array.isArray(wd) ? wd : isArrayLike(wd) ? Object.values(wd) : null;
  if (values === null || values.length === 0 || values.length > 14) throw new BadRequest('weekdays non valido');
  const days = new Set<number>();
  for (const d of values) {
    if (!isInt(d) || d < 1 || d > 7) throw new BadRequest('weekdays deve contenere interi 1-7');
    days.add(d);
  }
  return {
    id,
    stopName,
    weekdays: [...days].sort((a, b) => a - b),
    hour,
    minute,
    source: validateSource(get(r, 'source')),
  };
}

export function validateSource(s: unknown): ReminderSource {
  const type = isArrayLike(s) ? get(s, 'type') : undefined;
  if (!isArrayLike(s) || typeof type !== 'string') throw new BadRequest('source non valida');
  switch (type) {
    case 'cotralBus':
      return { type, poleCode: text(get(s, 'poleCode'), 64, 'poleCode') };
    case 'cotralTrain': {
      const route = get(s, 'route');
      if (typeof route !== 'string' || !(TRAIN_ROUTES as readonly string[]).includes(route)) throw new BadRequest('source.route non valida');
      return { type, stationName: text(get(s, 'stationName'), 64, 'stationName'), route };
    }
    case 'atacStop':
      return { type, stopId: text(get(s, 'stopId'), 64, 'stopId') };
  }
  throw new BadRequest('source.type non valido');
}

/** PHP trim() strips exactly these (not the Unicode spaces String.prototype.trim also removes). */
const phpTrim = (v: string) => v.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function text(v: unknown, max: number, name: string): string {
  if (typeof v !== 'string') throw new BadRequest(`${name} mancante`);
  const t = phpTrim(v);
  // A lone surrogate (\ud800 escape) is invalid UTF-8 for PHP's json_decode/mb_check_encoding.
  if (t === '' || [...t].length > max || LONE_SURROGATE.test(t) || /[\x00-\x1f\x7f]/.test(t)) throw new BadRequest(`${name} non valido`);
  return t;
}
