import { useState, useEffect, useRef } from '../lib.js';

/** Re-renders every `ms` so relative labels ("tra 4 min") keep counting down between polls. */
export function useTick(ms = 20000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/**
 * Runs `fn` immediately and then every `ms` while mounted and the tab is visible (the sheet's own transit poll in iOS:
 * `startObservingTransits`/`stopObservingTransits`). `fn` receives an AbortSignal cancelled on unmount/deps change.
 */
export function usePolling(fn, ms, deps = []) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let stopped = false, running = false;
    const ctrl = new AbortController();
    const run = async () => {
      if (stopped || running || document.hidden) return;
      running = true;
      try { await fnRef.current(ctrl.signal); } catch (e) { if (e?.name !== 'AbortError') console.warn(e); } finally { running = false; }
    };
    run();
    const id = setInterval(run, ms);
    const onVis = () => { if (!document.hidden) run(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stopped = true; ctrl.abort(); clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, deps);
}
