import { html, useState } from '../lib.js';
import { Icon } from '../icons.js';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { favorites, favoritesStore } from '../favorites.js';
import { vehicleTracker, CONFIG } from '../services.js';
import { Sheet } from '../ui/Sheet.js';
import { Loading, EmptyState, Segmented, Dot } from '../ui/components.js';
import { useTick, usePolling } from '../ui/hooks.js';
import { trainRoute } from '../models.js';
import {
  extractLocality, poleDisplayName, poleSubtitle, trackingStatus, canTrackVehicle, displayTime, adjustedDisplayTime,
  transitMinutes, relativeLabel, minutesFromNowHHMM, upcoming, astralDelay,
} from '../util.js';

/** A static Cotral stop (from stops/search/line.php) as the UI's "pole" (port of PolesRepository.mapGtfsStopToPole). */
export function poleFromStop(s) {
  return {
    code: s.id, name: s.name, stopName: s.name, locality: s.locality ?? extractLocality(s.name),
    comune: null, lat: s.lat, lon: s.lon, rail: !!s.rail,
  };
}

/**
 * PIV.do's own pole info is often sparser than the GTFS-derived one — keep whichever value each field already has.
 * `code` always stays the GTFS-derived one: PIV.do's `<codice>` is a different id namespace, and letting it win used to
 * silently swap a pole's identity mid-session (favoriting before vs after the first refresh stored two ids → duplicates).
 */
function mergePole(base, update) {
  return {
    code: base.code,
    name: update.name || base.name,
    stopName: update.stopName || base.stopName,
    locality: update.locality || base.locality,
    comune: update.comune || base.comune,
    lat: update.lat ?? base.lat,
    lon: update.lon ?? base.lon,
    rail: base.rail,
  };
}

export function PoleSheetModal({ pole, onClose }) {
  return html`<${Sheet} onClose=${onClose}><${PoleSheet} pole=${pole} /><//>`;
}

export function PoleSheet({ pole: initialPole }) {
  const [pole, setPole] = useState(initialPole);
  const [state, setState] = useState('loading'); // loading | loaded | empty | error
  const [error, setError] = useState('');
  const [transits, setTransits] = useState([]);
  const [railDirections, setRailDirections] = useState([]);
  const [direction, setDirection] = useState(null);
  const favs = useStore(favoritesStore);
  const tracker = useStore(vehicleTracker.store);
  useTick(20000);

  const code = initialPole.code;

  usePolling(async (signal) => {
    if (initialPole.rail) await refreshRail(signal); else await refreshTransits(signal);
  }, CONFIG.transitsPollMs, [code]);

  async function refreshTransits(signal) {
    if (!code) { setState('error'); setError('Codice palina mancante.'); return; }
    try {
      const res = await api.cotralTransits(code, { signal });
      if (!res.pole) { setTransits([]); setState('empty'); return; }
      setPole((p) => mergePole(p, res.pole));
      // A run whose real (delay-adjusted) arrival passed by more than ~2 min is stale data — Cotral's feed can get stuck
      // reporting one forever. `transitMinutes` is delay-aware, so a run that's a couple of minutes late isn't dropped.
      const list = res.transits
        .filter((t) => (transitMinutes(t) ?? 0) >= -2)
        .sort((a, b) => (transitMinutes(a) ?? Infinity) - (transitMinutes(b) ?? Infinity));
      setTransits(list);
      setState('loaded');
      const followed = vehicleTracker.store.get().code;
      if (followed) {
        const match = list.find((t) => t.vehicleCode === followed);
        if (match && !match.vehicleAlive) vehicleTracker.reportOffline(followed);
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      setState('error'); setError(e.message);
    }
  }

  async function refreshRail(signal) {
    try {
      const res = await api.rail(code);
      setRailDirections(res.directions ?? []);
      setState((res.directions ?? []).length ? 'loaded' : 'empty');
    } catch (e) {
      setState('error'); setError(e.message);
    }
  }

  const isFav = favorites.isCotral(favs, pole.code);

  const header = html`
    <div class="sheet-header" data-drag>
      <div class="grow">
        <div class="t-title3">${poleDisplayName(pole)}</div>
        ${poleSubtitle(pole) && html`<div class="t-sub sec" style="margin-top:2px">${poleSubtitle(pole)}</div>`}
      </div>
      ${pole.code && html`<button aria-label=${isFav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'} onClick=${() => favorites.toggleCotral(pole)} style="padding:4px">
        <${Icon} name="star" size=26 fill=${isFav} style=${{ color: 'var(--yellow)' }} />
      </button>`}
    </div>
    ${tracker.code && html`<${TrackingBanner} tracker=${tracker} />`}
    <div class="divider"></div>`;

  let content;
  if (pole.rail) {
    const directions = railDirections
      .map((d) => ({ destination: d.destination, entries: upcoming(d.entries) }))
      .sort((a, b) => (a.destination < b.destination ? -1 : 1));
    if (state === 'error') content = html`<${EmptyState} icon="wifi-off" title="Errore" message=${error} />`;
    else if (directions.length) content = html`<${RailSchedule} directions=${directions} direction=${direction} onDirection=${setDirection} />`;
    else if (state === 'loading') content = html`<${Loading} message="Carico gli orari…" />`;
    else content = html`<${EmptyState} icon="clock" title="Nessun transito disponibile" message="Al momento non risultano corse per questa stazione, in tempo reale né programmate, per il resto di oggi." />`;
  } else if (state === 'loading' && !transits.length) content = html`<${Loading} message="Carico i transiti…" />`;
  else if (state === 'error') content = html`<${EmptyState} icon="wifi-off" title="Errore" message=${error} />`;
  else if (state === 'empty') content = html`<${EmptyState} icon="clock" title="Nessun transito disponibile" message="Riprova più tardi o controlla un'altra palina." />`;
  else content = html`<div class="sheet-list">${transits.map((t) => html`<${TransitRow} key=${t.idCorsa || t.partenzaCorsa + t.arrivoCorsa} transit=${t} tracker=${tracker} isTreno=${pole.rail} />`)}</div>`;

  return html`${header}${content}`;
}

function TrackingBanner({ tracker }) {
  const lost = tracker.state === 'lost';
  return html`<div class=${'tracking-banner ' + (lost ? 'lost' : 'ok')}>
    <${Icon} name=${lost ? 'locate-off' : 'locate-fixed'} size=18 style=${{ color: lost ? 'var(--red)' : 'var(--orange)' }} />
    <div class="grow">
      ${lost
        ? html`<div class="t-foot semibold">Tracking interrotto</div><div class="t-cap2 sec">Il veicolo ${tracker.code} non trasmette più la posizione</div>`
        : html`<div class="t-foot semibold">Seguendo ${tracker.isTreno ? 'treno' : 'bus'} ${tracker.code}</div><div class="t-cap2 sec">Posizione aggiornata ogni ${CONFIG.vehiclePositionPollMs / 1000}s</div>`}
    </div>
    <button class="btn btn-bordered small" onClick=${() => vehicleTracker.stop()}>Ferma</button>
  </div>`;
}

/** Cotral bus run (PIV.do) — port of TransitRowView. */
function TransitRow({ transit: t, tracker, isTreno }) {
  const status = trackingStatus(t);
  const reliable = status === 'realtime';
  const minutes = transitMinutes(t);
  const destination = t.arrivoCorsa ? extractLocality(t.arrivoCorsa) : 'Destinazione N/D';
  // For a Cotral train `percorso` literally is an internal route code (e.g. "RL_PSP-CC") — meaningless to a rider.
  const label = trainRoute(t.percorso) || !t.percorso ? destination : `${t.percorso} · ${destination}`;
  const hasDelay = reliable && Math.abs(t.ritardoSeconds) >= 60;
  const delayText = !hasDelay ? 'puntuale' : t.ritardoSeconds > 0
    ? `in ritardo di ${Math.floor(Math.abs(t.ritardoSeconds) / 60)} min`
    : `in anticipo di ${Math.floor(Math.abs(t.ritardoSeconds) / 60)} min`;
  const delayClass = !hasDelay ? 'sec' : t.ritardoSeconds > 0 ? 'red' : 'green';
  const following = tracker.code === t.vehicleCode;
  const rel = relativeLabel(minutes);

  return html`<div class="t-row">
    <div class="t-time">
      <div class="big">${displayTime(t) ? adjustedDisplayTime(t) : '--:--'}</div>
      ${rel && html`<div class="t-cap sec">${rel}</div>`}
    </div>
    <div class="grow col" style="gap:4px">
      <div class="t-sub semibold clamp2">${label}</div>
      <div class="status t-cap">
        ${status === 'realtime' && html`<${Dot} color="green" /><span class=${delayClass}>Real-time · ${delayText}</span>`}
        ${status === 'monitoredOffline' && html`<${Dot} color="yellow" /><span class="sec">Tracciata, bus non in trasmissione</span>`}
        ${status === 'scheduled' && html`<${Dot} color="gray" /><span class="sec">Schedulata, no real-time</span>`}
      </div>
      ${t.instradamento && html`<div class="t-cap2 sec ellipsis">${t.instradamento}</div>`}
    </div>
    ${canTrackVehicle(t) && html`<button class=${'btn btn-bordered btn-stack ' + (following ? 'orange' : '')} onClick=${() => vehicleTracker.toggle(t.vehicleCode, isTreno)}>
      <${Icon} name=${following ? 'locate-fixed' : 'locate'} size=18 />
      <span>${following ? 'Seguito' : 'Segui'}</span>
    </button>`}
  </div>`;
}

/** Cotral rail station schedule (ASTRAL, GTFS fallback) — port of railScheduleView + AstralDepartureRow. */
function RailSchedule({ directions, direction, onDirection }) {
  const current = directions.find((d) => d.destination === direction) ?? directions[0];
  // Entries with no delay figure at all fell through to the static-GTFS tier (genuine ASTRAL data almost always has one,
  // even "0") — a reliable enough signal to label the two cases honestly.
  const isEstimate = !current.entries.some((e) => e.delayMinutes != null);
  const nextId = current.entries[0]?.id;

  return html`
    ${isEstimate && html`<div class="notice"><${Icon} name="calendar" size=15 />Orario stimato da tabella, non in tempo reale</div>`}
    <div class="sheet-pad" style="padding-top:8px;padding-bottom:0">
      ${directions.length > 1
        ? html`<${Segmented} options=${directions.map((d) => ({ value: d.destination, label: d.destination }))} value=${current.destination} onChange=${onDirection} />`
        : html`<div class="t-sub semibold sec">Verso ${current.destination}</div>`}
    </div>
    ${current.entries.length === 0
      ? html`<${EmptyState} icon="moon" title="Corse terminate per oggi" message=${`Non risultano altre corse programmate verso ${current.destination} per il resto di oggi.`} />`
      : html`<div class="sheet-list">${current.entries.map((e) => html`<${AstralRow} key=${e.id + e.time} departure=${e} isNext=${e.id === nextId} />`)}</div>`}`;
}

function AstralRow({ departure: d, isNext }) {
  const minutes = minutesFromNowHHMM(d.time);
  const rel = relativeLabel(minutes, 'in arrivo');
  const delay = astralDelay(d.delayMinutes);
  const toneClass = delay?.tone === 'late' ? 'red' : delay?.tone === 'early' ? 'green' : 'sec';
  return html`<div class=${'t-row center ' + (d.isCancelled ? 'dim' : '')}>
    <div class="t-time">
      <div class="big">${d.time}</div>
      ${rel && html`<div class="t-cap sec">${rel}</div>`}
    </div>
    <div class="grow col" style="gap:4px">
      ${!d.isCancelled && (delay
        ? html`<div class="status"><${Dot} color="green" pulse=${true} /><span class=${'t-sub semibold ' + toneClass}>${delay.text}</span></div>`
        : html`<div class="status"><${Dot} color="gray" /><span class="t-sub semibold sec">Schedulata</span></div>`)}
      ${d.isReplacementBus && html`<div class="t-cap2 sec row" style="gap:4px"><${Icon} name="bus" size=12 />Bus sostitutivo</div>`}
    </div>
    ${d.isCancelled
      ? html`<span class="capsule red">Soppressa</span>`
      : isNext ? html`<span class="capsule accent">Prossimo treno</span>` : null}
  </div>`;
}
