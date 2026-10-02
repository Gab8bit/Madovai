import { useState, useEffect } from './lib.js';

/** Minimal observable store (the web counterpart of an ObservableObject). */
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(next) {
      state = typeof next === 'function' ? next(state) : next;
      subs.forEach((fn) => fn(state));
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

export function useStore(store, selector = (s) => s) {
  const [value, setValue] = useState(() => selector(store.get()));
  useEffect(() => {
    setValue(selector(store.get()));
    return store.subscribe((s) => setValue(selector(s)));
  }, [store]);
  return value;
}

/** localStorage with try/catch everywhere: private windows and blocked storage must degrade to "nothing persisted", never crash. */
export const storage = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};
