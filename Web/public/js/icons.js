import { html } from './lib.js';
import { ICONS } from './icons-data.js';

// SF Symbols can't be used outside Apple platforms (license), so the web port
// uses Lucide (ISC) — same meaning, same weight, drawn as inline SVG so it
// inherits `currentColor` exactly like an SF Symbol inherits the foreground style.
const EXTRA = {
  // "m.circle.fill" stand-in for the metro (no equivalent in Lucide).
  metro: '<circle cx="12" cy="12" r="9"/><path d="M8 16V8l4 5 4-5v8"/>',
};

/**
 * @param {{name:string,size?:number,fill?:boolean,strokeWidth?:number,class?:string,style?:object}} props
 */
export function Icon({ name, size = 20, fill = false, strokeWidth = 2, class: cls = '', style }) {
  const inner = EXTRA[name] ?? ICONS[name] ?? '';
  return html`<svg class=${'icon ' + cls} style=${style} width=${size} height=${size} viewBox="0 0 24 24"
    fill=${fill ? 'currentColor' : 'none'} stroke="currentColor" stroke-width=${strokeWidth}
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    dangerouslySetInnerHTML=${{ __html: inner }}></svg>`;
}

/** Raw SVG string for places that build HTML strings (Leaflet divIcons). */
export function iconSvg(name, size = 14, { fill = false, strokeWidth = 2 } = {}) {
  const inner = EXTRA[name] ?? ICONS[name] ?? '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/** SF Symbol name used by the iOS app → Lucide equivalent, per vehicle kind. */
export const KIND_ICON = { bus: 'bus', tram: 'tram-front', metro: 'metro', treno: 'tram-front' };
