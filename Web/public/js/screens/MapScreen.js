import { html, useState, useEffect, useRef, useMemo, useCallback } from '../lib.js';
import { Icon } from '../icons.js';
import { api, loadLines } from '../api.js';
import { useStore } from '../store.js';
import { favorites, favoritesStore } from '../favorites.js';
import { atacRealtime, cotralVehicles, vehicleTracker, location, CONFIG } from '../services.js';
import { createMapController } from '../map/MapController.js';
import { SearchBar } from './SearchBar.js';
import { PoleSheetModal, poleFromStop } from './PoleSheet.js';
import { AtacStopSheetModal, AtacVehicleSheetModal, CotralVehicleSheetModal } from './AtacSheets.js';
import { InfoSheetModal } from './InfoSheet.js';
import { LineSheetModal } from './LineeScreen.js';
import { ErrorBanner } from '../ui/components.js';
import { groupStopsByName } from '../util.js';
import { TRAIN_ROUTES } from '../models.js';

const MIN_DATA_ZOOM = 13; // below this a regional/urban viewport would drown in stops; same reason iOS caps results per viewport.

function pad(bounds) {
  const latPad = (bounds.getNorth() - bounds.getSouth()) * 0.15 + 0.01;
  const lonPad = (bounds.getEast() - bounds.getWest()) * 0.15 + 0.01;
  return { minLat: bounds.getSouth() - latPad, maxLat: bounds.getNorth() + latPad, minLon: bounds.getWest() - lonPad, maxLon: bounds.getEast() + lonPad };
}

/** Resolves a focused line id (Atac route id, or a Cotral `percorso` train code) to its drawable shapes + stops. */
async function loadFocus(routeId) {
  const empty = { routeId, kind: 'unknown', shapes: [], stops: [], route: null };
  try {
    const data = await api.line('atac', routeId);
    return { routeId, kind: 'atac', route: data.route, stops: data.stops, shapes: data.shapes.map((s) => ({ ...s, kind: data.route.kind, color: data.route.color })) };
  } catch { /* not an Atac route id */ }
  // A focused Cotral vehicle's routeId is its `percorso` (a rail direction code) — translate to the GTFS rail route by short name.
  const tr = TRAIN_ROUTES[routeId];
  if (!tr) return empty;
  try {
    const lines = await loadLines();
    const rail = (lines.cotralRail ?? []).find((r) => String(r.shortName).toUpperCase() === tr.gtfs);
    if (!rail) return empty;
    const data = await api.line('cotral', rail.id);
    return { routeId, kind: 'cotral', route: data.route, stops: [], shapes: data.shapes.map((s) => ({ ...s, kind: 'treno', color: null })) };
  } catch { return empty; }
}

export function MapScreen({ active }) {
  const elRef = useRef(null);
  const ctlRef = useRef(null);
  const handlersRef = useRef({});
  const [viewport, setViewport] = useState(null); // settled { bounds, zoom }
  const settleTimer = useRef(null);

  const [poles, setPoles] = useState([]);
  const [atacStops, setAtacStops] = useState([]);
  const [viewportShapes, setViewportShapes] = useState([]);
  const [linesVisible, setLinesVisible] = useState(true);
  const [routePoles, setRoutePoles] = useState(null); // transient override after "jump to a Cotral line" (replaced on next settle)
  const [focus, setFocus] = useState(null); // {routeId, kind, shapes, stops, route}
  const [dataError, setDataError] = useState(null);
  const [mapMessage, setMapMessage] = useState(null);
  const [loadingData, setLoadingData] = useState(false);
  const pending = useRef(0);

  const [selectedPole, setSelectedPole] = useState(null);
  const [selectedAtac, setSelectedAtac] = useState(null); // {stops, routeId}
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [searchedCotralRoute, setSearchedCotralRoute] = useState(null);
  const [showInfo, setShowInfo] = useState(false);

  const favs = useStore(favoritesStore);
  const rt = useStore(atacRealtime.store);
  const cv = useStore(cotralVehicles.store);
  const tracker = useStore(vehicleTracker.store);
  const loc = useStore(location.store);
  const hasCenteredOnUser = useRef(false);

  // ───── map lifecycle ─────
  useEffect(() => {
    const ctl = createMapController(elRef.current, {
      onMove: ({ bounds, zoom }) => {
        clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => setViewport({ bounds, zoom }), CONFIG.viewportSettleMs);
      },
      onPoleClick: (p) => handlersRef.current.onPole(p),
      onAtacStopClick: (s) => handlersRef.current.onAtacStop(s),
      onVehicleClick: (v) => handlersRef.current.onVehicle(v),
    });
    ctlRef.current = ctl;
    ctl.emitMove();
    atacRealtime.start();
    cotralVehicles.start();
    location.start();
    return () => { clearTimeout(settleTimer.current); ctl.destroy(); };
  }, []);

  useEffect(() => { if (active) setTimeout(() => ctlRef.current?.invalidate(), 50); }, [active]);

  // ───── viewport → stops + shapes ─────
  const loadViewport = useCallback(async (signal) => {
    if (!viewport) return;
    if (viewport.zoom < MIN_DATA_ZOOM) { setPoles([]); setAtacStops([]); setViewportShapes([]); setDataError(null); return; }
    const b = pad(viewport.bounds);
    // Non-blocking hint, shown only if the request is actually slow (no flicker on fast connections).
    pending.current += 1;
    const slow = setTimeout(() => { if (pending.current > 0) setLoadingData(true); }, 400);
    try {
      const [stopsRes, shapesRes] = await Promise.all([
        api.stops(b, { signal }),
        linesVisible ? api.shapes(b, { signal }) : Promise.resolve({ shapes: [] }),
      ]);
      setPoles(stopsRes.cotral.map(poleFromStop));
      setAtacStops(stopsRes.atac);
      setViewportShapes(shapesRes.shapes ?? []);
      setRoutePoles(null);
      setDataError(null);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setDataError({ message: e.message, notReady: e.status === 503 });
    } finally {
      clearTimeout(slow);
      pending.current -= 1;
      if (pending.current <= 0) { pending.current = 0; setLoadingData(false); }
    }
  }, [viewport, linesVisible]);

  useEffect(() => {
    const ctrl = new AbortController();
    loadViewport(ctrl.signal);
    return () => ctrl.abort();
  }, [loadViewport]);

  const shownPoles = focus ? [] : (routePoles ?? poles);
  useEffect(() => { cotralVehicles.updateVisiblePoles(poles); }, [poles]);

  const shownAtacStops = useMemo(() => {
    if (focus) return focus.kind === 'atac' ? groupStopsByName(focus.stops).map((g) => g.anchor) : [];
    return groupStopsByName(atacStops).map((g) => g.anchor);
  }, [focus, atacStops]);
  const shownShapes = focus ? focus.shapes : (linesVisible ? viewportShapes : []);

  const allVehicles = useMemo(() => [...rt.vehicles, ...cv.vehicles], [rt.vehicles, cv.vehicles]);
  const shownVehicles = useMemo(() => {
    if (focus) return allVehicles.filter((v) => v.routeId === focus.routeId);
    if (!viewport) return [];
    const b = pad(viewport.bounds);
    return allVehicles.filter((v) => v.lat >= b.minLat && v.lat <= b.maxLat && v.lon >= b.minLon && v.lon <= b.maxLon);
  }, [allVehicles, focus, viewport]);

  // ───── push state to the map ─────
  useEffect(() => { ctlRef.current?.setPoles(shownPoles, favorites.cotralCodes(favs)); }, [shownPoles, favs]);
  useEffect(() => { ctlRef.current?.setAtacStops(shownAtacStops); }, [shownAtacStops]);
  useEffect(() => { ctlRef.current?.setShapes(shownShapes); }, [shownShapes]);
  useEffect(() => { ctlRef.current?.setVehicles(shownVehicles); }, [shownVehicles]);
  useEffect(() => {
    ctlRef.current?.setFollowed(tracker.coord ? { coord: tracker.coord, isTreno: tracker.isTreno, lost: tracker.state === 'lost' } : null);
  }, [tracker.coord, tracker.isTreno, tracker.state]);
  useEffect(() => { ctlRef.current?.setUserLocation(loc.coord); }, [loc.coord]);

  // First GPS fix only orients the very first viewport; after that the map is the user's (a dedicated flag, not "no poles in view",
  // which used to make the map fight panning whenever the user moved somewhere with no stops).
  useEffect(() => {
    if (loc.coord && !hasCenteredOnUser.current) {
      hasCenteredOnUser.current = true;
      ctlRef.current?.flyTo(loc.coord.lat, loc.coord.lon, 16);
    }
  }, [loc.coord]);

  // ───── interactions ─────
  const openAtacGroup = useCallback(async (stop, routeId = null) => {
    try {
      const data = await api.atacStop(stop.id, routeId ?? undefined);
      setSelectedAtac({ stops: data.stops?.length ? data.stops : [{ ...stop, headsign: null }], routeId });
    } catch { setSelectedAtac({ stops: [{ ...stop, headsign: null }], routeId }); }
  }, []);

  const focusRoute = useCallback(async (routeId) => {
    if (!routeId) { setFocus(null); return; }
    setFocus({ routeId, kind: 'loading', shapes: [], stops: [], route: null });
    setFocus(await loadFocus(routeId));
  }, []);

  handlersRef.current = {
    onPole: (p) => setSelectedPole(p),
    onAtacStop: (s) => openAtacGroup(s, focus?.kind === 'atac' ? focus.routeId : null),
    onVehicle: (v) => { setSelectedVehicle(v); focusRoute(v.routeId); },
  };

  const onSelectStop = async (s) => {
    ctlRef.current?.flyTo(s.lat, s.lon, 16);
    if (s.source === 'cotral') setSelectedPole(poleFromStop(s));
    else openAtacGroup(s, null);
  };

  const onSelectRoute = async (r) => {
    setMapMessage(null);
    try {
      if (r.source === 'cotral') {
        // Shows all of the line's stops immediately (they may well fall outside the eventual viewport) and opens its station list.
        const data = await api.line('cotral', r.id);
        if (!data.stops.length) { setMapMessage(`Nessuna fermata trovata per la linea "${r.shortName}".`); return; }
        setFocus(null);
        setRoutePoles(data.stops.map((s) => poleFromStop({ ...s, rail: r.rail })));
        ctlRef.current?.fitPoints(data.stops.map((s) => [s.lat, s.lon]), 14);
        setSearchedCotralRoute(r);
      } else {
        const data = await api.line('atac', r.id);
        const pts = data.shapes.length ? data.shapes.flatMap((s) => decodeForFit(s)) : [];
        if (!pts.length) { setMapMessage(`Nessun percorso trovato per la linea "${r.shortName}".`); return; }
        ctlRef.current?.fitPoints(pts, 15);
        setFocus({ routeId: r.id, kind: 'atac', route: data.route, stops: data.stops, shapes: data.shapes.map((s) => ({ ...s, kind: data.route.kind, color: data.route.color })) });
      }
    } catch (e) { setMapMessage(e.message); }
  };

  const goToMyLocation = () => {
    if (loc.coord) ctlRef.current?.flyTo(loc.coord.lat, loc.coord.lon, 16);
    else location.restart();
  };

  const denied = loc.status === 'denied' || loc.status === 'unavailable';

  return html`<div class=${'tab-screen map-screen ' + (active ? 'active' : '')}>
    <div class="map-root" ref=${elRef}></div>

    <div class="map-top">
      <${SearchBar} onSelectStop=${onSelectStop} onSelectRoute=${onSelectRoute} />
      ${loadingData && !dataError && html`<div class="loading-banner glass-soft" role="status"><div class="spinner"></div><span>Caricamento dati…</span></div>`}
      ${dataError && html`<${ErrorBanner} title=${dataError.notReady ? 'Dati non ancora disponibili' : 'Errore di connessione'}
        message=${dataError.notReady ? 'Il server sta ancora preparando i dati delle linee. Riprova tra qualche minuto.' : dataError.message}
        onRetry=${() => loadViewport()} />`}
      ${focus && html`<div class="banner glass-soft" style="align-items:center;padding:8px 12px">
        <${Icon} name="route" size=18 style=${{ color: 'var(--tint)' }} />
        <div class="grow t-sub semibold">Mostro solo questa linea</div>
        <button class="row t-sub semibold" style="gap:5px;color:var(--tint)" onClick=${() => setFocus(null)}><${Icon} name="circle-x" size=18 />Reset</button>
      </div>`}
      ${mapMessage && html`<${ErrorBanner} title="Nessun risultato" message=${mapMessage} />`}
      ${denied && html`<div class="banner glass-soft">
        <${Icon} name="locate-off" size=22 style=${{ color: 'var(--red)', marginTop: '2px' }} />
        <div class="grow"><div class="b-title">Posizione non disponibile</div>
          <div class="b-text">Attiva la posizione nelle impostazioni del browser per vedere le paline vicine, oppure cerca una località.</div></div>
        <button class="btn btn-bordered small" onClick=${() => location.restart()}>Riprova</button>
      </div>`}
    </div>

    <div class="map-controls">
      <button class="glass-btn glass" aria-label="La mia posizione" onClick=${goToMyLocation}><${Icon} name="locate-fixed" size=22 /></button>
      <button class=${'glass-btn glass ' + (linesVisible ? 'on' : 'off')} aria-label="Mostra o nascondi le linee" aria-pressed=${linesVisible} onClick=${() => setLinesVisible((v) => !v)}><${Icon} name="route" size=22 /></button>
      <button class="glass-btn glass" aria-label="Informazioni" onClick=${() => setShowInfo(true)}><${Icon} name="info" size=22 /></button>
    </div>

    ${selectedPole && html`<${PoleSheetModal} key=${selectedPole.code} pole=${selectedPole} onClose=${() => setSelectedPole(null)} />`}
    ${selectedAtac && html`<${AtacStopSheetModal} key=${selectedAtac.stops[0].id} stops=${selectedAtac.stops} routeId=${selectedAtac.routeId} onClose=${() => setSelectedAtac(null)} />`}
    ${selectedVehicle && (selectedVehicle.operator === 'Cotral'
      ? html`<${CotralVehicleSheetModal} key=${selectedVehicle.id} vehicle=${selectedVehicle} onClose=${() => setSelectedVehicle(null)} />`
      : html`<${AtacVehicleSheetModal} key=${selectedVehicle.id} vehicle=${selectedVehicle} onClose=${() => setSelectedVehicle(null)} />`)}
    ${searchedCotralRoute && html`<${LineSheetModal} route=${searchedCotralRoute} onClose=${() => setSearchedCotralRoute(null)} />`}
    ${showInfo && html`<${InfoSheetModal} onClose=${() => setShowInfo(false)} />`}
  </div>`;
}

import { decodePolyline } from '../util.js';
function decodeForFit(shape) { return decodePolyline(shape.coords); }
