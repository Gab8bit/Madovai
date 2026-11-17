import { iconSvg, KIND_ICON } from '../icons.js';
import { esc } from '../ui/components.js';
import { vehicleColor, lineStrokeColor } from '../models.js';
import { decodePolyline } from '../util.js';

const L = window.L;

// Keyless raster tiles. To use another provider (MapTiler, Stadia, a self-hosted tile server…) change just this URL —
// the "muted" look and the dark theme are done with CSS filters on `.base-tiles` (see app.css), not baked into the tiles.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ROME = [41.9028, 12.4964];
const hasHover = window.matchMedia?.('(hover: hover)').matches;

/**
 * Imperative wrapper around Leaflet. The React side hands it plain data through the `set*` methods and it
 * diffs against what's on the map — the same job the iOS `MapContainerView.updateUIView` does for MKMapView.
 */
export function createMapController(container, handlers) {
  const map = L.map(container, { zoomControl: false, attributionControl: true, zoomSnap: 0.5, worldCopyJump: false, tap: true })
    .setView(ROME, 13);
  map.attributionControl.setPosition('bottomleft');
  map.attributionControl.setPrefix(false);

  // Muted base map (iOS used MKStandardMapConfiguration(.muted)): desaturated via CSS; inverted automatically in dark mode.
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION, className: 'base-tiles' }).addTo(map);

  map.createPane('shapes').style.zIndex = 420;
  map.createPane('stops').style.zIndex = 430;
  const shapesRenderer = L.canvas({ pane: 'shapes', padding: 0.4 });
  const stopsRenderer = L.canvas({ pane: 'stops', padding: 0.4, tolerance: 8 });

  const poleMarkers = new Map();   // code → { marker, key }
  const atacMarkers = new Map();   // id → circleMarker
  const shapeLayers = new Map();   // shape id → polyline
  const vehicleMarkers = new Map(); // id → { marker, anim, key }
  let followed = null;
  let userMarker = null, userAccuracy = null;
  const tweens = new Set();
  let raf = 0;

  const emitMove = () => handlers.onMove?.({ bounds: map.getBounds(), zoom: map.getZoom() });
  map.on('moveend', emitMove);
  // At wide zoom hundreds of labelled vehicle badges pile up: shrink them to dots (CSS .zoom-low).
  const syncZoomClass = () => map.getContainer().classList.toggle('zoom-low', map.getZoom() < 14);
  map.on('zoomend', syncZoomClass);
  syncZoomClass();

  // ───── Cotral poles (the MKMarkerAnnotationView balloons) ─────
  function poleIcon(pole, isFavorite) {
    const bg = isFavorite ? 'var(--yellow)' : pole.rail ? 'var(--indigo)' : 'var(--blue)';
    return L.divIcon({
      className: 'pin-wrap', iconSize: [30, 38], iconAnchor: [15, 36],
      html: `<div class="pole-pin" style="background:${bg}">${iconSvg(pole.rail ? 'tram-front' : 'bus', 15, { strokeWidth: 2.2 })}</div>`,
    });
  }
  function setPoles(poles, favoriteCodes) {
    const wanted = new Set(poles.map((p) => p.code));
    for (const [code, entry] of poleMarkers) {
      if (!wanted.has(code)) { entry.marker.remove(); poleMarkers.delete(code); }
    }
    for (const pole of poles) {
      if (pole.lat == null || pole.lon == null) continue;
      const fav = favoriteCodes.has(pole.code);
      const key = fav ? 'f' : 'n';
      const existing = poleMarkers.get(pole.code);
      if (existing) {
        existing.pole = pole;
        if (existing.key !== key) { existing.marker.setIcon(poleIcon(pole, fav)); existing.key = key; }
        continue;
      }
      const marker = L.marker([pole.lat, pole.lon], { icon: poleIcon(pole, fav), keyboard: false, riseOnHover: true });
      const entry = { marker, key, pole };
      marker.on('click', (e) => { L.DomEvent.stopPropagation(e); handlers.onPoleClick?.(entry.pole); });
      if (hasHover) marker.bindTooltip(esc(pole.name || pole.code), { className: 'madovai-tip', direction: 'top', offset: [0, -34] });
      marker.addTo(map);
      poleMarkers.set(pole.code, entry);
    }
  }

  // ───── Atac / Roma TPL stops (small orange dots, hundreds at once → canvas) ─────
  function setAtacStops(stops) {
    const wanted = new Set(stops.map((s) => s.id));
    for (const [id, m] of atacMarkers) {
      if (!wanted.has(id)) { m.remove(); atacMarkers.delete(id); }
    }
    for (const stop of stops) {
      if (atacMarkers.has(stop.id)) continue;
      const m = L.circleMarker([stop.lat, stop.lon], {
        renderer: stopsRenderer, pane: 'stops', radius: 6, weight: 1.5, color: '#fff', fillColor: '#ff9500', fillOpacity: 1, bubblingMouseEvents: false,
      });
      m.on('click', (e) => { L.DomEvent.stopPropagation(e); handlers.onAtacStopClick?.(stop); });
      if (hasHover) m.bindTooltip(esc(stop.name), { className: 'madovai-tip', direction: 'top' });
      m.addTo(map);
      atacMarkers.set(stop.id, m);
    }
  }

  // ───── Line shapes ─────
  function setShapes(shapes) {
    const wanted = new Set(shapes.map((s) => s.id));
    for (const [id, layer] of shapeLayers) {
      if (!wanted.has(id)) { layer.remove(); shapeLayers.delete(id); }
    }
    for (const shape of shapes) {
      if (shapeLayers.has(shape.id)) continue;
      const line = L.polyline(decodePolyline(shape.coords), {
        renderer: shapesRenderer, pane: 'shapes', color: lineStrokeColor(shape.kind, shape.color), weight: 2.5, opacity: 0.92, interactive: false, smoothFactor: 1.5,
      }).addTo(map);
      shapeLayers.set(shape.id, line);
    }
  }

  // ───── Ambient vehicles (Atac fleet + Cotral opportunistic) ─────
  function vehicleIcon(v) {
    const label = v.routeLabel && v.routeLabel.length <= 3 ? esc(v.routeLabel) : null;
    const inner = label ?? iconSvg(KIND_ICON[v.kind] ?? 'bus', 14, { strokeWidth: 2.2 });
    return L.divIcon({
      className: 'pin-wrap', iconSize: [28, 28], iconAnchor: [14, 14],
      html: `<div class="veh-pin" style="background:${vehicleColor(v)}">${inner}</div>`,
    });
  }
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function tick(now) {
    for (const tw of tweens) {
      const t = Math.min(1, (now - tw.start) / tw.duration);
      const k = ease(t);
      tw.marker.setLatLng([tw.from[0] + (tw.to[0] - tw.from[0]) * k, tw.from[1] + (tw.to[1] - tw.from[1]) * k]);
      if (t >= 1) tweens.delete(tw);
    }
    raf = tweens.size ? requestAnimationFrame(tick) : 0;
  }
  function glide(marker, to, duration = 1000) {
    const cur = marker.getLatLng();
    if (Math.abs(cur.lat - to[0]) < 1e-6 && Math.abs(cur.lng - to[1]) < 1e-6) return;
    for (const tw of tweens) if (tw.marker === marker) tweens.delete(tw);
    tweens.add({ marker, from: [cur.lat, cur.lng], to, start: performance.now(), duration });
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function setVehicles(vehicles) {
    const wanted = new Set(vehicles.map((v) => v.id));
    for (const [id, entry] of vehicleMarkers) {
      if (!wanted.has(id)) { entry.marker.remove(); vehicleMarkers.delete(id); }
    }
    for (const v of vehicles) {
      const key = `${v.routeLabel}|${v.kind}|${v.operator}`;
      const existing = vehicleMarkers.get(v.id);
      if (existing) {
        existing.vehicle = v;
        if (existing.key !== key) { existing.marker.setIcon(vehicleIcon(v)); existing.key = key; }
        glide(existing.marker, [v.lat, v.lon]);
        continue;
      }
      const marker = L.marker([v.lat, v.lon], { icon: vehicleIcon(v), keyboard: false, zIndexOffset: 500 });
      const entry = { marker, key, vehicle: v };
      marker.on('click', (e) => { L.DomEvent.stopPropagation(e); handlers.onVehicleClick?.(entry.vehicle); });
      if (hasHover) marker.bindTooltip(esc(v.routeLabel ? `Linea ${v.routeLabel}` : v.operator), { className: 'madovai-tip', direction: 'top', offset: [0, -12] });
      marker.addTo(map);
      vehicleMarkers.set(v.id, entry);
    }
  }

  // ───── The single explicitly-followed vehicle ("segui bus") ─────
  function setFollowed(state) {
    if (!state?.coord) {
      followed?.marker.remove();
      followed = null;
      return;
    }
    const to = [state.coord.lat, state.coord.lon];
    const html = `<div class="follow-pin ${state.lost ? 'lost' : ''}">${iconSvg(state.isTreno ? 'tram-front' : 'bus', 20, { strokeWidth: 2.2 })}</div>`;
    if (!followed) {
      const marker = L.marker(to, {
        icon: L.divIcon({ className: 'pin-wrap', iconSize: [40, 40], iconAnchor: [20, 20], html }), zIndexOffset: 1000, keyboard: false,
      }).addTo(map);
      if (hasHover) marker.bindTooltip(state.isTreno ? 'Treno in tempo reale' : 'Bus in tempo reale', { className: 'madovai-tip', direction: 'top', offset: [0, -20] });
      followed = { marker, html };
      return;
    }
    if (followed.html !== html) {
      followed.marker.setIcon(L.divIcon({ className: 'pin-wrap', iconSize: [40, 40], iconAnchor: [20, 20], html }));
      followed.html = html;
    }
    glide(followed.marker, to);
  }

  // ───── User location ─────
  function setUserLocation(loc) {
    if (!loc) { userMarker?.remove(); userAccuracy?.remove(); userMarker = userAccuracy = null; return; }
    const ll = [loc.lat, loc.lon];
    if (!userMarker) {
      userAccuracy = L.circle(ll, { radius: loc.accuracy ?? 30, weight: 0, fillColor: '#0a84ff', fillOpacity: 0.12, interactive: false }).addTo(map);
      userMarker = L.marker(ll, {
        icon: L.divIcon({ className: 'pin-wrap', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="me-dot"></div>' }),
        interactive: false, keyboard: false, zIndexOffset: 900,
      }).addTo(map);
    } else {
      userMarker.setLatLng(ll);
      userAccuracy.setLatLng(ll).setRadius(loc.accuracy ?? 30);
    }
  }

  return {
    map,
    setPoles, setAtacStops, setShapes, setVehicles, setFollowed, setUserLocation,
    getBounds: () => map.getBounds(),
    getZoom: () => map.getZoom(),
    /** Recenters like MKMapView.setRegion(… latitudinalMeters: 900): ~900 m across → zoom 16. */
    flyTo(lat, lon, zoom = 16) { map.flyTo([lat, lon], zoom, { duration: 0.8 }); },
    setView(lat, lon, zoom) { map.setView([lat, lon], zoom, { animate: false }); },
    fitPoints(points, maxZoom = 15) {
      if (!points.length) return;
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom, animate: true });
    },
    invalidate() { map.invalidateSize(); },
    emitMove,
    destroy() { map.remove(); },
  };
}
