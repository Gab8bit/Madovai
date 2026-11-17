// Client for the Madovai backend (https://madovai.gab8bit.net/api/v1, see the backend's docs/API.md).
// The base URL lives in public/config.js so it can be changed without touching the code.

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const DEFAULT_BASE = 'https://madovai.gab8bit.net/api/v1';
const API_BASE = String(window.MADOVAI_CONFIG?.apiBase || DEFAULT_BASE).replace(/\/+$/, '');

function endpoint(name, params) {
  // A relative base (e.g. "/madovai/api/v1" behind a reverse proxy) resolves against the page; an absolute one is used as is.
  const url = new URL(`${API_BASE}/${name}`, document.baseURI);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url;
}

async function request(name, params, { signal, method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(endpoint(name, params), {
      signal,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Connessione assente o server non raggiungibile.', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    // Rate limiting (429) and the other backend errors carry an Italian, user-presentable `error`.
    throw new ApiError(data?.error ?? `Errore del server (${res.status})`, res.status);
  }
  return data;
}

const bboxParams = (b) => ({ minLat: b.minLat, minLon: b.minLon, maxLat: b.maxLat, maxLon: b.maxLon });

/** A Web Push subscription as the backend's `Device` object. */
const webPushDevice = (subscription) => ({ type: 'webpush', subscription });

export const api = {
  stops: (bounds, { cotralLimit = 120, atacLimit = 400, signal } = {}) =>
    request('stops', { ...bboxParams(bounds), cotralLimit, atacLimit }, { signal }),
  shapes: (bounds, { limit = 150, signal } = {}) => request('shapes', { ...bboxParams(bounds), limit }, { signal }),
  search: (q, { signal } = {}) => request('search', { q }, { signal }),
  lines: () => request('lines'),
  line: (source, id) => request('line', { source, id }),
  atacStop: (id, route) => request('atac-stop', { id, route }),
  atacSchedule: (stop) => request('atac-schedule', { stop }),
  pole: (id) => request('pole', { id }),
  rail: (stop) => request('rail', { stop }),

  cotralTransits: (pole, { signal } = {}) => request('cotral-transits', { pole }, { signal }),
  cotralVehicle: (code, { signal } = {}) => request('cotral-vehicle', { code }, { signal }),
  cotralVehicles: (poles, { signal } = {}) => request('cotral-vehicles', { poles: poles.join(',') }, { signal }),
  astralLine: (route) => request('astral-line', { route }),
  atacVehicles: ({ signal } = {}) => request('atac-vehicles', {}, { signal }),
  atacLive: (stops, { signal } = {}) => request('atac-live', { stops: stops.join(',') }, { signal }),
  atacTrip: (trip, { signal } = {}) => request('atac-trip', { trip }, { signal }),

  /** Which notification channels the server can reach; `webPush.publicKey` is the VAPID applicationServerKey (null = unavailable). */
  pushConfig: () => request('push/config'),
  saveReminders: (subscription, reminders) => request('reminders', {}, { method: 'POST', body: { device: webPushDevice(subscription), reminders } }),
  unsubscribe: (subscription) => request('devices', {}, { method: 'DELETE', body: { device: webPushDevice(subscription) } }),
  pushTest: (subscription) => request('push/test', {}, { method: 'POST', body: { device: webPushDevice(subscription) } }),
};

/** The "Linee" list is the same for everyone and ~430 rows: fetched once per page load. */
let linesPromise = null;
export function loadLines() {
  linesPromise ??= api.lines().catch((e) => { linesPromise = null; throw e; });
  return linesPromise;
}
