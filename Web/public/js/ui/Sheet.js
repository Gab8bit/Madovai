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

  useEffect(() => () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
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
  // Move/up listeners live on `window` for the duration of the gesture, so they keep working when the pointer leaves
  // the sheet (a mouse drag, or a fast finger) without needing pointer capture.
  const onPointerDown = (e) => {
    const handle = e.target.closest?.('.grabber-zone, [data-drag]');
    if (!handle || !sheetRef.current) return;
    if (e.target.closest('button, a, input, select, textarea') && !e.target.closest('.grabber-zone')) return;
    drag.current = { startY: e.clientY, startH: sheetRef.current.offsetHeight, lastY: e.clientY, lastT: performance.now(), vy: 0, active: false };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };
  function onPointerMove(e) {
    const d = drag.current;
    if (!d) return;
    if (!d.active) {
      if (Math.abs(e.clientY - d.startY) < 5) return;
      d.active = true;
      sheetRef.current.classList.add('dragging');
    }
    const now = performance.now();
    d.vy = (e.clientY - d.lastY) / Math.max(1, now - d.lastT); // px/ms, + = downwards
    d.lastY = e.clientY; d.lastT = now;
    const maxH = px('large');
    const h = Math.max(60, Math.min(maxH, d.startH - (e.clientY - d.startY)));
    sheetRef.current.style.height = h + 'px';
  }
  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (!d.active) return;
    const el = sheetRef.current;
    el.classList.remove('dragging');
    const h = el.offsetHeight;
    const mediumH = px('medium'), largeH = px('large');
    // A "fling" needs real travel: a tap with a few px of finger jitter has a huge px/ms velocity but isn't a gesture.
    const traveled = Math.abs(d.lastY - d.startY);
    const flingDown = traveled > 28 && d.vy > 0.6, flingUp = traveled > 28 && d.vy < -0.6;
    const canLarge = detents.includes('large'), canMedium = detents.includes('medium');
    // Like iOS: a downward fling from the large detent settles at medium first; only from medium (or below) it dismisses.
    const startedLarge = d.startH > mediumH + 20;
    if (h < mediumH * 0.6 || (flingDown && !startedLarge)) { close(); return; }
    let target;
    if (flingUp && canLarge) target = 'large';
    else if (flingDown && canMedium) target = 'medium';
    else target = canLarge && (!canMedium || Math.abs(h - largeH) < Math.abs(h - mediumH)) ? 'large' : 'medium';
    // Re-apply the height explicitly instead of clearing it: the framework only writes `style.height` when the detent
    // changes, so clearing it and snapping back to the SAME detent used to leave the sheet with no height at all
    // (auto = as tall as its content, header and grabber pushed off-screen, impossible to dismiss).
    el.style.height = target === 'large' ? LARGE : MEDIUM;
    setDetent(target);
  }

  const height = detent === 'large' ? LARGE : MEDIUM;
  const out = phase !== 'open';
  return html`<${Portal}>
    <${SheetContext.Provider} value=${{ close, detent, setDetent }}>
      <div class="sheet-layer">
        <div class=${'sheet-scrim ' + (phase === 'open' ? 'on' : '')} onClick=${close}></div>
        <div ref=${sheetRef} class=${'sheet ' + (form ? 'form-sheet' : '')} role="dialog" aria-modal="true"
          style=${{ height, transform: out ? 'translateY(100%)' : 'translateY(0)' }}
          onPointerDown=${onPointerDown}>
          <div class="grabber-zone"><div class="grabber"></div></div>
          <div class="sheet-body">${children}</div>
        </div>
      </div>
    <//>
  <//>`;
}
