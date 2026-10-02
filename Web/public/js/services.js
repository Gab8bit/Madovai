import { createStore } from './store.js';
import { api } from './api.js';

// Intervals/thresholds mirror Config.swift.
export const CONFIG = {
  transitsPollMs: 15000,
  vehiclePositionPollMs: 12000,
  atacRealtimePollMs: 18000,
  cotralViewportVehiclePollMs: 18000,
  vehicleTrackingLossThreshold: 2,
  viewportSettleMs: 600,
  cotralViewportPoleQueryLimit: 15,
};

/**
 * Runs `fn` now and then every `ms`, but only while the tab is visible (a hidden tab shouldn't hammer the
 * upstream feeds or the battery), refreshing immediately when it becomes visible again.
 * Returns a stop function. Overlapping runs are skipped.
 */
export function poll(fn, ms) {
  let timer = null, running = false, stopped = false;
  const run = async () => {
    if (running || stopped || document.hidden) return;
    running = true;
    try { await fn(); } catch { /* individual services record their own errors */ } finally { running = false; }
  };
  const start = () => { clearInterval(timer); timer = setInterval(run, ms); };
  const onVis = () => { if (!document.hidden) run(); };
  document.addEventListener('visibilitychange', onVis);
  start();
  run();
  return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
}

// ───────────────────────── Atac / Roma TPL full fleet ─────────────────────────
export const atacRealtime = {
  store: createStore({ vehicles: [], updated: null, error: null }),
  _stop: null,
  start() {
    if (this._stop) return;
    this._stop = poll(async () => {
      try {
        const data = await api.atacVehicles();
        this.store.set({ vehicles: data.vehicles ?? [], updated: data.updated ?? null, error: null });
      } catch (e) {
        this.store.set((s) => ({ ...s, error: e.message }));
      }
    }, CONFIG.atacRealtimePollMs);
  },
};

// ───────────────────────── Cotral viewport vehicles ─────────────────────────
// There is no "every active Cotral vehicle" endpoint: a vehicle only shows up after querying transits for a
// specific pole, so this scans whichever poles are currently visible (server-side fan-out, see api/cotral-vehicles.php).
export const cotralVehicles = {
  store: createStore({ vehicles: [] }),
  _codes: [],
  _byId: new Map(),
  _misses: new Map(),
  _scanning: false,
  _needsRescan: false,
  _stop: null,

  start() {
    if (this._stop) return;
    this._stop = poll(() => this.requestScan(), CONFIG.cotralViewportVehiclePollMs);
  },
  /** Called whenever the visible Cotral poles change (viewport settle). */
  updateVisiblePoles(poles) {
    this._codes = poles.map((p) => p.code).filter(Boolean).slice(0, CONFIG.cotralViewportPoleQueryLimit);
    this.requestScan();
  },
  /**
   * Serialises every trigger (periodic tick + viewport settle) through one gate: a request arriving mid-scan becomes
   * exactly one follow-up scan, so two overlapping scans can never finish out of order and stomp each other.
   */
  async requestScan() {
    if (this._scanning) { this._needsRescan = true; return; }
    await this._scan();
    while (this._needsRescan) { this._needsRescan = false; await this._scan(); }
  },
  async _scan() {
    this._scanning = true;
    try {
      if (!this._codes.length) {
        this._byId = new Map(); this._misses = new Map();
        this.store.set({ vehicles: [] });
        return;
      }
      let fresh;
      try { fresh = (await api.cotralVehicles(this._codes)).vehicles ?? []; } catch { return; }
      // A vehicle missing from one cycle (any transient hiccup in the two upstream round trips) keeps its last
      // position for a couple of misses instead of blinking off the map and back.
      const merged = new Map(), misses = new Map();
      for (const v of fresh) { merged.set(v.id, { ...v, operator: 'Cotral' }); misses.set(v.id, 0); }
      for (const [id, v] of this._byId) {
        if (merged.has(id)) continue;
        const n = (this._misses.get(id) ?? 0) + 1;
        if (n > CONFIG.vehicleTrackingLossThreshold) continue;
        merged.set(id, v); misses.set(id, n);
      }
      this._byId = merged; this._misses = misses;
      this.store.set({ vehicles: [...merged.values()] });
    } finally { this._scanning = false; }
  },
};

// ───────────────────────── The single explicitly-followed vehicle ─────────────────────────
export const vehicleTracker = {
  store: createStore({ code: null, isTreno: false, coord: null, state: 'idle', lastUpdated: null }),
  _stop: null,
  _misses: 0,

  isFollowing(code) { return this.store.get().code === code; },
  toggle(code, isTreno = false) { this.isFollowing(code) ? this.stop() : this.start(code, isTreno); },
  start(code, isTreno = false) {
    this._stop?.();
    this._misses = 0;
    this.store.set({ code, isTreno, coord: null, state: 'tracking', lastUpdated: null });
    this._stop = poll(() => this._refresh(code), CONFIG.vehiclePositionPollMs);
  },
  stop() {
    this._stop?.(); this._stop = null; this._misses = 0;
    this.store.set({ code: null, isTreno: false, coord: null, state: 'idle', lastUpdated: null });
  },
  /** A pole's transit poll noticed `vehicleAlive == false` — more immediate than waiting out the miss threshold. */
  reportOffline(code) {
    const s = this.store.get();
    if (s.code === code && s.state !== 'idle') this._markLost();
  },
  async _refresh(code) {
    try {
      const pos = await api.cotralVehicle(code);
      if (this.store.get().code !== code) return;
      if (pos && pos.lat != null && pos.lon != null) {
        this._misses = 0;
        this.store.set((s) => ({ ...s, coord: { lat: pos.lat, lon: pos.lon }, state: 'tracking', lastUpdated: Date.now() }));
      } else this._miss();
    } catch { this._miss(); }
  },
  _miss() { this._misses += 1; if (this._misses >= CONFIG.vehicleTrackingLossThreshold) this._markLost(); },
  _markLost() { this.store.set((s) => (s.state === 'idle' ? s : { ...s, state: 'lost' })); },
};

// ───────────────────────── Geolocation ─────────────────────────
export const location = {
  store: createStore({ coord: null, status: 'unknown' }), // status: unknown | granted | denied | unavailable
  _watch: null,
  start() {
    if (this._watch != null) return;
    if (!('geolocation' in navigator)) { this.store.set((s) => ({ ...s, status: 'unavailable' })); return; }
    this._watch = navigator.geolocation.watchPosition(
      (p) => this.store.set({ status: 'granted', coord: { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy } }),
      (err) => {
        if (err.code === 1) { this._watch = null; this.store.set((s) => ({ ...s, status: 'denied' })); }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  },
  /** Explicit retry (the "my location" button after a denial). */
  restart() {
    if (this._watch != null) { navigator.geolocation.clearWatch(this._watch); this._watch = null; }
    this.start();
  },
};
