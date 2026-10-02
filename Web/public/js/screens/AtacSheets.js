import { html, useState, useRef } from '../lib.js';
import { Icon, KIND_ICON } from '../icons.js';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { favorites, favoritesStore } from '../favorites.js';
import { atacRealtime } from '../services.js';
import { Sheet } from '../ui/Sheet.js';
import { Loading, EmptyState, Segmented, Dot } from '../ui/components.js';
import { useTick, usePolling } from '../ui/hooks.js';
import { metroName, trainRoute } from '../models.js';
import { clockFromTs, delayLabelFromSeconds, astralDelay, minutesFromNowHHMM, relativeLabel } from '../util.js';

// ───────────────────────── Atac / Roma TPL stop ─────────────────────────

export function AtacStopSheetModal({ stops, routeId, onClose }) {
  return html`<${Sheet} onClose=${onClose}><${AtacStopSheet} stops=${stops} routeId=${routeId} /><//>`;
}

/**
 * Live predictions (GTFS-Realtime trip_updates) for a station; when a platform has none at all, a best-effort
 * static-timetable estimate instead. `stops` can hold several platforms of one station (one per direction) — a picker
 * switches between them, labelled by each platform's own direction.
 */
export function AtacStopSheet({ stops, routeId }) {
  const [selectedId, setSelectedId] = useState(stops[0].id);
  const [live, setLive] = useState(null);
  const [fallback, setFallback] = useState([]);
  const [loadingFallback, setLoadingFallback] = useState(false);
  const [error, setError] = useState(null);
  const fallbackFor = useRef(null);
  const favs = useStore(favoritesStore);
  useTick(20000);

  const selected = stops.find((s) => s.id === selectedId) ?? stops[0];

  const select = (id) => { setSelectedId(id); setLive(null); setFallback([]); setError(null); fallbackFor.current = null; };

  usePolling(async (signal) => {
    const id = selected.id;
    try {
      const data = await api.atacLive([id], { signal });
      const list = data.stops?.[id] ?? [];
      setLive(list); setError(null);
      if (!list.length && fallbackFor.current !== id) {
        fallbackFor.current = id;
        setLoadingFallback(true);
        try { setFallback(await api.atacSchedule(id)); } catch { setFallback([]); } finally { setLoadingFallback(false); }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      setError(e.message);
      setLive((l) => l ?? []);
    }
  }, 15000, [selected.id]);

  const isFav = favorites.isAtac(favs, selected.id);
  const livePredictions = live ?? [];

  let content;
  if (live === null) content = html`<${Loading} message="Carico gli arrivi…" />`;
  else if (livePredictions.length) {
    content = html`<div class="sheet-list">${livePredictions.map((p) => html`<${PredictionRow} key=${p.tripId} p=${p} />`)}</div>`;
  } else if (loadingFallback) content = html`<${Loading} message="Cerco gli orari in programma…" />`;
  else if (fallback.length) {
    content = html`<div class="sheet-list">
      <div class="row sec t-foot" style="gap:8px;padding:10px 0;align-items:flex-start"><${Icon} name="info" size=16 style=${{ marginTop: '1px' }} />Nessun mezzo in tempo reale al momento: questi sono orari stimati da programmazione.</div>
      ${fallback.map((p) => html`<${PredictionRow} key=${p.tripId} p=${p} scheduled=${true} />`)}
    </div>`;
  } else if (error) content = html`<${EmptyState} icon="wifi-off" title="Errore" message=${error} />`;
  else content = html`<${EmptyState} icon="clock" title="Nessun transito in tempo reale" message="Questa fermata potrebbe non avere corse attive in questo momento." />`;

  return html`
    <div class="sheet-header" data-drag>
      <div class="grow">
        <div class="t-title3">${stops[0].name}</div>
        <div class="t-sub sec" style="margin-top:2px">Atac / Roma TPL · tempo reale</div>
      </div>
      <button aria-label=${isFav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'} onClick=${() => favorites.toggleAtac(selected)} style="padding:4px">
        <${Icon} name="star" size=26 fill=${isFav} style=${{ color: 'var(--yellow)' }} />
      </button>
    </div>
    ${stops.length > 1 && html`<div class="sheet-pad" style="padding-top:0;padding-bottom:8px">
      <${Segmented} options=${stops.map((s) => ({ value: s.id, label: s.headsign || s.name }))} value=${selected.id} onChange=${select} />
    </div>`}
    <div class="divider"></div>
    ${content}`;
}

function PredictionRow({ p, scheduled = false }) {
  const minutes = Math.trunc((p.ts * 1000 - Date.now()) / 60000);
  const rel = scheduled ? `tra ${Math.max(minutes, 0)} min` : relativeLabel(minutes, 'in arrivo');
  const delay = scheduled ? null : delayLabelFromSeconds(p.delaySeconds);
  return html`<div class="t-row center">
    <div class="t-time"><div class="big">${clockFromTs(p.ts)}</div><div class="t-cap sec">${rel}</div></div>
    <div class="col" style="width:48px;align-items:center;gap:2px;flex:none">
      <${Icon} name=${KIND_ICON[p.kind] ?? 'bus'} size=18 />
      <div class="t-cap bold">${p.routeLabel}</div>
    </div>
    <div class="grow col" style="gap:2px">
      ${p.headsign && html`<div class="t-sub ellipsis">verso ${p.headsign}</div>`}
      ${scheduled
        ? html`<div class="t-cap sec">stimato</div>`
        : delay && html`<div class=${'t-cap ' + (delay.late ? 'red' : 'green')}>${delay.text}</div>`}
    </div>
    <${Dot} color=${scheduled ? 'gray' : 'green'} />
  </div>`;
}

// ───────────────────────── Atac vehicle (full run schedule) ─────────────────────────

export function AtacVehicleSheetModal({ vehicle, onClose }) {
  return html`<${Sheet} onClose=${onClose}><${AtacVehicleSheet} vehicle=${vehicle} /><//>`;
}

export function AtacVehicleSheet({ vehicle }) {
  const [trip, setTrip] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const rt = useStore(atacRealtime.store);
  useTick(20000);
  // Re-resolved each refresh (position/delay change while the sheet is open) rather than freezing the tapped snapshot.
  const live = rt.vehicles.find((v) => v.id === vehicle.id) ?? vehicle;

  usePolling(async (signal) => {
    if (!vehicle.tripId) { setLoaded(true); return; }
    try { setTrip(await api.atacTrip(vehicle.tripId, { signal })); } catch (e) { if (e.name === 'AbortError') throw e; } finally { setLoaded(true); }
  }, 18000, [vehicle.tripId]);

  const lineLabel = metroName(live.routeLabel) ?? live.routeLabel ?? '—';
  const headsign = trip?.headsign || live.headsign;
  const stops = trip?.stops ?? [];

  return html`
    <div class="sheet-header" data-drag style="flex-direction:column;gap:2px">
      <div class="row" style="gap:6px"><${Icon} name=${KIND_ICON[live.kind] ?? 'bus'} size=20 /><span class="t-title3">${headsign ? `Linea ${lineLabel} verso ${headsign}` : `Linea ${lineLabel}`}</span></div>
      <div class="t-sub sec">${live.operator} · tempo reale</div>
    </div>
    <div class="divider"></div>
    ${!loaded ? html`<${Loading} message="Carico l'orario della corsa…" />`
      : !stops.length ? html`<${EmptyState} icon="clock" title="Orario non disponibile" message="Non ho ancora un aggiornamento in tempo reale per questa corsa." />`
      : html`<div class="sheet-list">${stops.map((s) => html`<${TripStopRow} key=${s.stopId + '-' + s.sequence} stop=${s} />`)}</div>`}`;
}

function TripStopRow({ stop }) {
  const past = stop.ts * 1000 < Date.now();
  const delay = delayLabelFromSeconds(stop.delaySeconds);
  return html`<div class=${'t-row center ' + (past ? 'dim' : '')} style="padding:7px 0">
    <div class="grow col" style="gap:1px">
      <div class="t-sub semibold">${stop.stopName}</div>
      ${delay && html`<div class=${'t-cap ' + (delay.late ? 'red' : 'green')}>${delay.text}</div>`}
    </div>
    <div class="t-sub mono">${clockFromTs(stop.ts)}</div>
  </div>`;
}

// ───────────────────────── Cotral vehicle (line schedule from ASTRAL) ─────────────────────────

export function CotralVehicleSheetModal({ vehicle, onClose }) {
  return html`<${Sheet} onClose=${onClose}><${CotralVehicleSheet} vehicle=${vehicle} /><//>`;
}

/**
 * Cotral's live GPS endpoint has no per-run itinerary, so for a train this shows ASTRAL's published timetable for the
 * vehicle's own direction (line schedule — not proof-linked to this specific vehicle). Every station's next passage,
 * sorted by that time ("what's coming up next, anywhere on the line").
 */
export function CotralVehicleSheet({ vehicle }) {
  const route = vehicle.routeId && trainRoute(vehicle.routeId) ? vehicle.routeId : null;
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(route ? 'loading' : 'idle'); // loading | ok | failed | idle
  useTick(20000);

  usePolling(async () => {
    if (!route) return;
    try { setData(await api.astralLine(route)); setStatus('ok'); } catch { setStatus((s) => (s === 'ok' ? s : 'failed')); }
  }, 30000, [route]);

  const info = route ? trainRoute(route) : null;
  const lineLabel = info ? info.line : vehicle.routeLabel ?? '—';
  const delay = delayLabelFromSeconds(vehicle.delaySeconds);
  const stations = [...(data?.stations ?? [])].sort((a, b) => (a.next?.sortSeconds ?? Infinity) - (b.next?.sortSeconds ?? Infinity));

  let body;
  if (status === 'loading') body = html`<${Loading} message="Carico l'orario della linea…" />`;
  else if (!route) body = html`<${EmptyState} icon="info" title="Itinerario non disponibile" message="Per questo veicolo Cotral l'itinerario completo non è disponibile." />`;
  else if (!stations.length) body = html`<${EmptyState} icon="info" title=${status === 'failed' ? 'Orario non disponibile' : 'Itinerario del veicolo non disponibile'}
      message=${status === 'failed' ? 'Non è stato possibile recuperare l\'orario di questa linea al momento.' : 'Non risultano corse programmate per questa linea per il resto di oggi.'} />`;
  else body = html`<div class="sheet-list">
    <div style="padding:8px 0">
      <div class="row sec t-cap" style="gap:6px"><${Icon} name="calendar" size=14 />Orario della linea, non di questa specifica corsa</div>
      ${info && html`<div class="t-cap semibold sec" style="margin-top:4px">${info.label}</div>`}
    </div>
    ${stations.map((s) => html`<${StationNextRow} key=${s.code} station=${s} />`)}
  </div>`;

  return html`
    <div class="sheet-header" data-drag style="flex-direction:column;gap:2px">
      <div class="row" style="gap:6px"><${Icon} name=${vehicle.kind === 'treno' ? 'tram-front' : 'bus'} size=20 /><span class="t-title3">Linea ${lineLabel}</span></div>
      <div class="t-sub sec">Cotral · posizione in tempo reale</div>
      ${delay && html`<div class=${'t-cap ' + (delay.late ? 'red' : 'green')}>${delay.text}</div>`}
    </div>
    <div class="divider"></div>
    ${body}`;
}

function StationNextRow({ station }) {
  const n = station.next;
  const delay = n && !n.isCancelled ? astralDelay(n.delayMinutes) : null;
  const tone = delay?.tone === 'late' ? 'red' : delay?.tone === 'early' ? 'green' : 'sec';
  return html`<div class="row" style="padding:8px 0;gap:12px;align-items:flex-start">
    <div class="grow t-sub">${station.name}</div>
    ${n ? html`<div class="col" style="align-items:flex-end;gap:2px">
        <div class="row" style="gap:6px">${n.isReplacementBus && html`<${Icon} name="bus" size=14 style=${{ color: 'var(--text-2)' }} />`}<span class="t-sub semibold mono">${n.time}</span></div>
        ${n.isCancelled ? html`<span class="capsule red">Soppressa</span>` : delay && html`<div class=${'t-cap ' + tone}>${delay.text.replace(/^./, (c) => c.toLowerCase())}</div>`}
      </div>`
      : html`<span class="t-cap ter">—</span>`}
  </div>`;
}
