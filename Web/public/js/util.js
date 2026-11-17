// Formatting/time helpers shared by every screen. All "now" logic is Rome wall-clock time:
// Cotral/ASTRAL/GTFS times are Rome local, so a visitor abroad must still see consistent "tra N min".

const romeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** @returns {{h:number,m:number,s:number}} current Rome time of day */
export function romeNow(date = new Date()) {
  const parts = romeFmt.formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { h: get('hour'), m: get('minute'), s: get('second') };
}

export function romeSecondsSinceMidnight(date = new Date()) {
  const { h, m, s } = romeNow(date);
  return h * 3600 + m * 60 + s;
}

/** "HH:mm" in Rome time for a unix timestamp (seconds). */
export function clockFromTs(ts) {
  const { h, m } = romeNow(new Date(ts * 1000));
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// ───────────────────────── Cotral Transit (port of Transit.swift) ─────────────────────────

/** `monitorata == "1"` + vehicle transmitting → realtime; monitored but silent → monitoredOffline; else scheduled. */
export function trackingStatus(t) {
  if (t.monitorata !== '1') return 'scheduled';
  return t.vehicleAlive ? 'realtime' : 'monitoredOffline';
}
export const isDelayReliable = (t) => trackingStatus(t) === 'realtime';
export const canTrackVehicle = (t) => t.monitorata === '1' && !!t.vehicleCode;

export function displayTime(t) {
  return t.tempoTransito ? t.tempoTransito : t.orarioPartenzaCorsa;
}

/** displayTime corrected for a reliable delay (>= 60 s), wrapped to a 24h clock face — see Transit.adjustedDisplayTime. */
export function adjustedDisplayTime(t) {
  const base = displayTime(t);
  if (!isDelayReliable(t) || Math.abs(t.ritardoSeconds) < 60) return base;
  const parts = base.split(':');
  if (parts.length !== 2) return base;
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return base;
  const total = h * 3600 + m * 60 + t.ritardoSeconds;
  const wrapped = ((total % 86400) + 86400) % 86400;
  return String(Math.floor(wrapped / 3600)).padStart(2, '0') + ':' + String(Math.floor((wrapped % 3600) / 60)).padStart(2, '0');
}

/** Minutes from now until an "HH:MM" time, with the schedule's own midnight-rollover convention (Transit.minutesFromNow). */
export function minutesFromNowHHMM(time, now = new Date()) {
  const parts = String(time).split(':');
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const n = romeNow(now);
  let diff = h * 60 + m - (n.h * 60 + n.m);
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;
  return diff;
}

/** Delay-aware: backs the "tra N min" label, the sort order and the "already passed" filter alike. */
export const transitMinutes = (t) => minutesFromNowHHMM(adjustedDisplayTime(t));

export function relativeLabel(minutes, passedLabel = 'in transito') {
  if (minutes == null) return null;
  if (minutes <= 0) return passedLabel;
  if (minutes === 1) return 'tra 1 min';
  return `tra ${minutes} min`;
}

/** Cotral appends " (ff90006)"-style internal codes to destinations; same strip as GTFSTextUtils.extractLocalityFromStopName. */
export function extractLocality(name) {
  return String(name ?? '').split(/[|!(]/)[0].trim();
}

// ───────────────────────── Delay wording (identical thresholds to the iOS rows) ─────────────────────────

/** Minutes of delay from seconds, only when >= 60 s (a smaller gap isn't worth surfacing). */
export function delayLabelFromSeconds(seconds) {
  if (seconds == null || Math.abs(seconds) < 60) return null;
  const minutes = Math.floor(Math.abs(seconds) / 60);
  return { text: seconds > 0 ? `in ritardo di ${minutes} min` : `in anticipo di ${minutes} min`, late: seconds > 0 };
}

/** ASTRAL delays are already whole minutes. */
export function astralDelay(minutes) {
  if (minutes == null) return null;
  if (Math.abs(minutes) < 1) return { text: 'Puntuale', tone: 'neutral' };
  return minutes > 0
    ? { text: `In ritardo di ${minutes} min`, tone: 'late' }
    : { text: `In anticipo di ${Math.abs(minutes)} min`, tone: 'early' };
}

/** Entries still ahead of now (ASTRAL/GTFS return the whole day), soonest first — see [AstralDeparture].upcoming. */
export function upcoming(entries, now = new Date()) {
  const nowSeconds = romeSecondsSinceMidnight(now);
  return entries.filter((e) => e.sortSeconds >= nowSeconds).sort((a, b) => a.sortSeconds - b.sortSeconds);
}

// ───────────────────────── Map helpers ─────────────────────────

/** Decodes a Google Encoded Polyline (precision 5) into [[lat, lon], …]. */
export function decodePolyline(str) {
  const points = [];
  let index = 0, lat = 0, lon = 0;
  while (index < str.length) {
    for (const axis of [0, 1]) {
      let result = 0, shift = 0, byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lon += delta;
    }
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

/** Same-name Atac platforms → one station (port of groupedStopsByName). */
export function groupStopsByName(stops) {
  const order = [];
  const groups = new Map();
  for (const stop of stops) {
    const key = String(stop.name ?? '').trim();
    if (!key) continue;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(stop);
  }
  return order.map((name) => {
    const list = groups.get(name).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { name, stops: list, anchor: list[0] };
  });
}

/** Case-insensitive de-dup by trimmed name, keeping the first (LineeDetailView.dedupedByName). */
export function dedupedByName(stops) {
  const seen = new Set();
  return stops.filter((s) => {
    const key = String(s.name ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ───────────────────────── Misc ─────────────────────────

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
}));

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** A Pole as the UI sees it (port of Pole.displayName / subtitle). */
export function poleDisplayName(p) {
  return p.name || p.stopName || p.locality || `Palina ${p.code ?? ''}`;
}
export function poleSubtitle(p) {
  return [p.comune, p.locality].find((v) => v && v.length) ?? null;
}
