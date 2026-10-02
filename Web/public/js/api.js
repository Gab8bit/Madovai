// Thin client for public/api/*.php (contract: docs/API.md).

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function endpoint(name, params) {
  const url = new URL('api/' + name, document.baseURI);
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
  if (!res.ok) throw new ApiError(data?.error ?? `Errore del server (${res.status})`, res.status);
  return data;
}

const bboxParams = (b) => ({ minLat: b.minLat, minLon: b.minLon, maxLat: b.maxLat, maxLon: b.maxLon });

export const api = {
  stops: (bounds, { cotralLimit = 120, atacLimit = 400, signal } = {}) =>
    request('stops.php', { ...bboxParams(bounds), cotralLimit, atacLimit }, { signal }),
  shapes: (bounds, { limit = 150, signal } = {}) => request('shapes.php', { ...bboxParams(bounds), limit }, { signal }),
  search: (q, { signal } = {}) => request('search.php', { q }, { signal }),
  lines: () => request('lines.php'),
  line: (source, id) => request('line.php', { source, id }),
  atacStop: (id, route) => request('atac-stop.php', { id, route }),
  atacSchedule: (stop) => request('atac-schedule.php', { stop }),
  pole: (id) => request('pole.php', { id }),
  rail: (stop) => request('rail.php', { stop }),

  cotralTransits: (pole, { signal } = {}) => request('cotral-transits.php', { pole }, { signal }),
  cotralVehicle: (code, { signal } = {}) => request('cotral-vehicle.php', { code }, { signal }),
  cotralVehicles: (poles, { signal } = {}) => request('cotral-vehicles.php', { poles: poles.join(',') }, { signal }),
  astralLine: (route) => request('astral-line.php', { route }),
  atacVehicles: ({ signal } = {}) => request('atac-vehicles.php', {}, { signal }),
  atacLive: (stops, { signal } = {}) => request('atac-live.php', { stops: stops.join(',') }, { signal }),
  atacTrip: (trip, { signal } = {}) => request('atac-trip.php', { trip }, { signal }),

  pushKey: () => request('push-key.php'),
  saveReminders: (subscription, reminders) => request('reminders.php', {}, { method: 'POST', body: { subscription, reminders } }),
  unsubscribe: (subscription) => request('reminders.php', { action: 'unsubscribe' }, { method: 'POST', body: { subscription } }),
  pushTest: (subscription) => request('push-test.php', {}, { method: 'POST', body: { subscription } }),
};

/** The "Linee" list is the same for everyone and ~430 rows: fetched once per page load. */
let linesPromise = null;
export function loadLines() {
  linesPromise ??= api.lines().catch((e) => { linesPromise = null; throw e; });
  return linesPromise;
}
