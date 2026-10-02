import { html, render, useState, useEffect, useRef, useCallback, createContext, useContext } from '../lib.js';

/** Lets any child close the sheet it's in (with the slide-out animation). */
export const SheetContext = createContext({ close: () => {} });
export const useSheet = () => useContext(SheetContext);

/**
 * Renders its children into a fresh element appended to <body> (its own Preact root). Needed because a sheet opened from
 * inside another sheet would otherwise be `position: fixed` relative to the parent's `transform` (a CSS containing block),
 * not the viewport.
 */
function Portal({ children }) {
  const hostRef = useRef(null);
  if (!hostRef.current) {
    hostRef.current = document.createElement('div');
    document.body.appendChild(hostRef.current);
  }
  useEffect(() => () => { render(null, hostRef.current); hostRef.current.remove(); }, []);
  render(children, hostRef.current);
  return null;
}

const MEDIUM = 'min(max(360px, 52dvh), calc(100dvh - var(--safe-top) - 10px))';
const LARGE = 'calc(100dvh - var(--safe-top) - 10px)';

/**
 * Bottom sheet with `.medium` / `.large` detents, drag-to-resize/dismiss on the grabber (and on any
 * element carrying `data-drag`), same feel as SwiftUI's `.presentationDetents([.medium, .large])` +
 * `.presentationDragIndicator(.visible)`. Mounted = presented; `onClose` fires after the slide-out.
 *
 * @param {{onClose:()=>void, detents?:Array<'medium'|'large'>, initial?:'medium'|'large', form?:boolean, children:any}} props
 */
export function Sheet({ onClose, detents = ['medium', 'large'], initial = 'medium', form = false, children }) {
  const [detent, setDetent] = useState(detents.includes(initial) ? initial : detents[0]);
  const [phase, setPhase] = useState('entering'); // entering → open → leaving
  const sheetRef = useRef(null);
  const drag = useRef(null);
  const closedRef = useRef(false);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    setPhase('leaving');
    setTimeout(() => onClose?.(), 320);
  }, [onClose]);

  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('open')));
    return () => cancelAnimationFrame(id);
  }, []);

  // Esc closes (desktop).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const px = (name) => {
    // Resolve the CSS detent expressions to pixels by measuring a probe.
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;visibility:hidden;height:${name === 'large' ? LARGE : MEDIUM}`;
    document.body.appendChild(probe);
    const h = probe.offsetHeight;
    probe.remove();
    return h;
  };

  // A drag starts only after the pointer actually moves a few pixels, and never from an interactive element —
  // otherwise capturing the pointer on pointerdown would swallow the click on header buttons (e.g. the favorite star).
  const onPointerDown = (e) => {
    const handle = e.target.closest?.('.grabber-zone, [data-drag]');
    if (!handle || !sheetRef.current) return;
    if (e.target.closest('button, a, input, select, textarea') && !e.target.closest('.grabber-zone')) return;
    drag.current = { startY: e.clientY, startH: sheetRef.current.offsetHeight, lastY: e.clientY, lastT: performance.now(), vy: 0, active: false, pointerId: e.pointerId };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (!d.active) {
      if (Math.abs(e.clientY - d.startY) < 5) return;
      d.active = true;
      sheetRef.current.classList.add('dragging');
      sheetRef.current.setPointerCapture?.(d.pointerId);
    }
    const now = performance.now();
    d.vy = (e.clientY - d.lastY) / Math.max(1, now - d.lastT); // px/ms, + = downwards
    d.lastY = e.clientY; d.lastT = now;
    const maxH = px('large');
    const h = Math.max(60, Math.min(maxH, d.startH - (e.clientY - d.startY)));
    sheetRef.current.style.height = h + 'px';
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (!d.active) return;
    const el = sheetRef.current;
    el.classList.remove('dragging');
    const h = el.offsetHeight;
    el.style.height = '';
    const mediumH = px('medium'), largeH = px('large');
    const flingDown = d.vy > 0.6, flingUp = d.vy < -0.6;
    const canLarge = detents.includes('large'), canMedium = detents.includes('medium');
    if (flingDown && h < largeH - 40 || h < mediumH * 0.6) { close(); return; }
    if (flingUp && canLarge) { setDetent('large'); return; }
    if (flingDown && canMedium && h >= mediumH * 0.6) { setDetent('medium'); return; }
    const target = canLarge && (!canMedium || Math.abs(h - largeH) < Math.abs(h - mediumH)) ? 'large' : 'medium';
    setDetent(target);
  };

  const height = detent === 'large' ? LARGE : MEDIUM;
  const out = phase !== 'open';
  return html`<${Portal}>
    <${SheetContext.Provider} value=${{ close, detent, setDetent }}>
      <div class="sheet-layer">
        <div class=${'sheet-scrim ' + (phase === 'open' ? 'on' : '')} onClick=${close}></div>
        <div ref=${sheetRef} class=${'sheet ' + (form ? 'form-sheet' : '')} role="dialog" aria-modal="true"
          style=${{ height, transform: out ? 'translateY(100%)' : 'translateY(0)' }}
          onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${onPointerUp}>
          <div class="grabber-zone"><div class="grabber"></div></div>
          <div class="sheet-body">${children}</div>
        </div>
      </div>
    <//>
  <//>`;
}
