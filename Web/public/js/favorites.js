import { createStore, storage } from './store.js';

// Favorite stops from either operator, purely local (localStorage) — same shape/ids as the iOS FavoriteStop:
//   { id: "cotral:<code>", kind: "cotral", pole: {code, name, stopName, locality, comune, lat, lon, rail} }
//   { id: "atac:<stopId>",  kind: "atac",  stop: {id, name, lat, lon} }
// Namespaced ids so a Cotral and an Atac id that collide as bare strings can't be mistaken for one favorite.
const KEY = 'madovai.favorites';

function load() {
  const items = storage.read(KEY, []);
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  // Self-heal duplicates (kept from the iOS port: first occurrence of each id wins).
  return items.filter((it) => it && typeof it.id === 'string' && !seen.has(it.id) && seen.add(it.id));
}

export const favoritesStore = createStore(load());

function persist(items) { storage.write(KEY, items); }

function toggleItem(item) {
  favoritesStore.set((items) => {
    const next = items.some((i) => i.id === item.id) ? items.filter((i) => i.id !== item.id) : [...items, item];
    persist(next);
    return next;
  });
}

export const favorites = {
  isCotral: (items, code) => items.some((i) => i.id === `cotral:${code}`),
  isAtac: (items, stopId) => items.some((i) => i.id === `atac:${stopId}`),
  cotralCodes: (items) => new Set(items.filter((i) => i.kind === 'cotral').map((i) => i.pole.code)),
  toggleCotral(pole) {
    if (!pole.code) return;
    toggleItem({ id: `cotral:${pole.code}`, kind: 'cotral', pole });
  },
  toggleAtac(stop) {
    toggleItem({ id: `atac:${stop.id}`, kind: 'atac', stop: { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon } });
  },
};

export function favoriteName(item) {
  return item.kind === 'cotral' ? (item.pole.name || item.pole.stopName || item.pole.locality || `Palina ${item.pole.code}`) : item.stop.name;
}
export function favoriteSubtitle(item) {
  return item.kind === 'cotral' ? ([item.pole.comune, item.pole.locality].find((v) => v) ?? null) : 'Atac / Roma TPL';
}
