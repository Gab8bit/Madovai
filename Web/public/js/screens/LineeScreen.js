import { html, useState, useEffect, useMemo } from '../lib.js';
import { Icon, KIND_ICON } from '../icons.js';
import { api, loadLines } from '../api.js';
import { useStore } from '../store.js';
import { atacRealtime } from '../services.js';
import { Sheet, useSheet } from '../ui/Sheet.js';
import { Section, NavBar, InfoLabel, Loading, EmptyState } from '../ui/components.js';
import { usePolling, useTick } from '../ui/hooks.js';
import { PoleSheetModal, poleFromStop } from './PoleSheet.js';
import { AtacStopSheetModal } from './AtacSheets.js';
import { groupStopsByName, dedupedByName } from '../util.js';

const routeIcon = (r) => (r.source === 'cotral' ? (r.rail ? 'tram-front' : 'bus') : (KIND_ICON[r.kind] ?? 'bus'));
const routeSubtitle = (r) => (r.source === 'cotral' ? (r.rail ? 'Cotral · treno' : 'Cotral') : r.operator);

/**
 * Standalone line browser, no map. Limited to lines where that's meaningful: Atac/Roma TPL (full live fleet + stop
 * predictions) and Cotral's rail lines. Cotral's ~4000 bus routes are deliberately left out (no per-line live data,
 * a list that size would dominate the screen).
 */
export function LineeScreen({ active }) {
  const [lines, setLines] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => { loadLines().then(setLines).catch((e) => setError(e.message)); }, []);

  const { trains, buses } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filt = (list) => list
      .filter((r) => !q || r.shortName.toLowerCase().includes(q) || (r.longName ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.shortName < b.shortName ? -1 : a.shortName > b.shortName ? 1 : 0));
    const atac = lines?.atac ?? [];
    return {
      trains: filt([...atac.filter((r) => r.kind === 'metro'), ...(lines?.cotralRail ?? [])]),
      buses: filt(atac.filter((r) => r.kind === 'bus' || r.kind === 'tram')),
    };
  }, [lines, query]);

  const row = (r) => html`<button key=${r.source + r.id} class="list-row" onClick=${() => setSelected(r)}>
    <${Icon} name=${routeIcon(r)} size=20 style=${{ color: 'var(--tint)' }} />
    <div class="grow col" style="gap:2px"><div class="t-sub semibold">${r.displayName}</div>${r.longName && html`<div class="t-cap sec ellipsis">${r.longName}</div>`}</div>
    <span class="t-cap2 ter">${routeSubtitle(r)}</span>
    <${Icon} name="chevron-right" size=16 class="chevron" />
  </button>`;

  return html`<div class=${'tab-screen ' + (active ? 'active' : '')}>
    ${selected
      ? html`<div class="navscreen">
          <${NavBar} title=${selected.displayName} onBack=${() => setSelected(null)} backLabel="Linee" />
          <div class="scroll big-top"><${LineDetail} route=${selected} /></div>
        </div>`
      : html`<div class="navscreen">
          <${NavBar} title="Linee" />
          <div class="scroll big-top">
            <div style="padding:0 16px 14px"><div class="search-bar glass-soft" style="box-shadow:none">
              <${Icon} name="search" size=18 style=${{ color: 'var(--text-2)' }} />
              <input type="search" placeholder="Cerca una linea" autocomplete="off" autocorrect="off" spellcheck="false" value=${query} onInput=${(e) => setQuery(e.target.value)} />
            </div></div>
            ${trains.length > 0 && html`<${Section} title="Treni">${trains.map(row)}<//>`}
            ${buses.length > 0 && html`<${Section} title="Bus">${buses.map(row)}<//>`}
            ${!trains.length && !buses.length && html`<div class="list-card pad t-sub sec" style="padding:14px 16px">${error ?? (lines ? 'Nessuna linea trovata.' : 'Carico le linee…')}</div>`}
          </div>
        </div>`}
  </div>`;
}

/** Line detail used by the Linee tab (pushed) and by the search-result sheet. */
export function LineDetail({ route }) {
  return route.source === 'atac' ? html`<${AtacLineDetail} route=${route} />` : html`<${CotralRailLineDetail} route=${route} />`;
}

/** A Cotral line picked from the map search bar — presented as a sheet (there's no navigation stack on the map to push onto). */
export function LineSheetModal({ route, onClose }) {
  return html`<${Sheet} onClose=${onClose} form=${true}><${LineSheetBody} route=${route} /><//>`;
}
function LineSheetBody({ route }) {
  const { close } = useSheet();
  return html`<div class="navscreen" style="background:var(--bg)">
    <${NavBar} title=${route.displayName} trailing=${html`<button class="nav-btn" style="font-weight:600" onClick=${close}>Fine</button>`} />
    <div class="scroll in-sheet big-top"><${LineDetail} route=${route} /></div>
  </div>`;
}

// ───────────────────────── Atac / Roma TPL line ─────────────────────────

function AtacLineDetail({ route }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [arrivals, setArrivals] = useState({});
  const [station, setStation] = useState(null);
  const rt = useStore(atacRealtime.store);
  useTick(20000);

  useEffect(() => { api.line('atac', route.id).then(setData).catch((e) => setError(e.message)); }, [route.id]);

  const groups = useMemo(() => groupStopsByName(data?.stops ?? []), [data]);
  const vehicles = rt.vehicles.filter((v) => v.routeId === route.id);

  usePolling(async (signal) => {
    if (!data?.stops?.length) return;
    const res = await api.atacLive(data.stops.map((s) => s.id), { signal });
    setArrivals(res.stops ?? {});
  }, 18000, [data]);

  const nextFor = (group) => {
    const all = group.stops.flatMap((s) => arrivals[s.id] ?? []).filter((p) => p.routeId === route.id);
    return all.length ? all.reduce((a, b) => (b.ts < a.ts ? b : a)) : null;
  };

  return html`
    <${Section}><div class="list-row" style="min-height:44px"><${Icon} name=${KIND_ICON[route.kind] ?? 'bus'} size=20 /><span class="t-sub grow">${route.displayName}</span></div><//>

    <${Section} title=${`Veicoli in tempo reale (${vehicles.length})`}>
      ${vehicles.length === 0
        ? html`<div class="pad t-foot sec">Nessun veicolo attivo al momento su questa linea.</div>`
        : vehicles.map((v) => html`<div key=${v.id} class="list-row">
            <${Icon} name=${KIND_ICON[v.kind] ?? 'bus'} size=20 style=${{ color: 'var(--teal)' }} />
            <div class="grow col" style="gap:1px"><div class="t-sub">Veicolo ${v.id.replace('atac-', '')}</div>${v.headsign && html`<div class="t-cap sec">verso ${v.headsign}</div>`}</div>
            <span class="dot green"></span>
          </div>`)}
    <//>

    <${Section} title=${`Fermate (${groups.length})`}>
      ${error ? html`<div class="pad t-foot sec">${error}</div>`
        : !data ? html`<div class="pad t-foot sec">Carico le fermate…</div>`
        : groups.length === 0 ? html`<div class="pad t-foot sec">Nessuna fermata trovata per questa linea nel riquadro considerato.</div>`
        : groups.map((g) => {
            const next = nextFor(g);
            const minutes = next ? Math.trunc((next.ts * 1000 - Date.now()) / 60000) : null;
            const directions = g.stops.length > 1 ? g.stops.map((s) => s.headsign).filter(Boolean) : [];
            return html`<button key=${g.name} class="list-row" onClick=${() => setStation(g)}>
              <div class="grow col" style="gap:1px"><div class="t-sub">${g.name}</div>${directions.length > 0 && html`<div class="t-cap2 ter">${directions.join(' · ')}</div>`}</div>
              ${next ? html`<span class="t-cap semibold green">${minutes <= 0 ? 'in arrivo' : `${minutes} min`}</span>` : html`<span class="t-cap ter">—</span>`}
              <${Icon} name="chevron-right" size=16 class="chevron" />
            </button>`;
          })}
    <//>
    ${station && html`<${AtacStopSheetModal} key=${station.name} stops=${station.stops} routeId=${route.id} onClose=${() => setStation(null)} />`}`;
}

// ───────────────────────── Cotral rail line ─────────────────────────

function CotralRailLineDetail({ route }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [pole, setPole] = useState(null);

  useEffect(() => { api.line('cotral', route.id).then(setData).catch((e) => setError(e.message)); }, [route.id]);
  const stops = useMemo(() => dedupedByName(data?.stops ?? []), [data]);

  return html`
    <${Section}><div class="pad"><${InfoLabel} icon="info">Gli orari di ogni stazione seguono Cotral in tempo reale quando disponibile, altrimenti un orario programmato — tocca una stazione per vederli.<//></div><//>
    <${Section} title=${`Stazioni (${stops.length})`}>
      ${error ? html`<div class="pad t-foot sec">${error}</div>`
        : !data ? html`<div class="pad t-foot sec">Carico le stazioni…</div>`
        : stops.map((s) => html`<button key=${s.id} class="list-row" onClick=${() => setPole(poleFromStop({ ...s, rail: route.rail }))}>
            <span class="t-sub grow">${s.name}</span><${Icon} name="chevron-right" size=16 class="chevron" />
          </button>`)}
    <//>
    ${pole && html`<${PoleSheetModal} key=${pole.code} pole=${pole} onClose=${() => setPole(null)} />`}`;
}
