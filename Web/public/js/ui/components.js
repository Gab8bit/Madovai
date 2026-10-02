import { html } from '../lib.js';
import { Icon } from '../icons.js';

export const Spinner = () => html`<div class="spinner" role="progressbar" aria-label="Caricamento"></div>`;

/** Loading block ("Carico i transiti…") — LoadingOverlay in the iOS app. */
export function Loading({ message = 'Caricamento…' }) {
  return html`<div class="center-fill"><${Spinner} /><div class="t-foot sec" style="margin-top:10px">${message}</div></div>`;
}

/** EmptyStateView */
export function EmptyState({ icon = 'tram-front', title, message, fill = true }) {
  return html`<div class=${fill ? 'center-fill' : ''}>
    <div class="empty">
      <${Icon} name=${icon} size=34 strokeWidth=1.6 />
      <div class="e-title">${title}</div>
      ${message && html`<div class="e-msg">${message}</div>`}
    </div></div>`;
}

/** ErrorBanner: network/server problem with an optional retry. */
export function ErrorBanner({ message, onRetry, title = 'Errore di connessione' }) {
  return html`<div class="banner glass-soft">
    <${Icon} name="wifi-off" size=22 style=${{ color: 'var(--red)', marginTop: '2px' }} />
    <div class="grow"><div class="b-title">${title}</div><div class="b-text">${message}</div></div>
    ${onRetry && html`<button class="btn btn-prominent" style="padding:6px 12px;font-size:13px" onClick=${onRetry}>Riprova</button>`}
  </div>`;
}

/** Inline informational line with an icon (SwiftUI `Label(…, systemImage: "info.circle")`). */
export function InfoLabel({ icon = 'info', children, class: cls = '' }) {
  return html`<div class=${'row sec t-foot ' + cls} style="gap:8px;align-items:flex-start"><${Icon} name=${icon} size=16 style=${{ marginTop: '1px' }} /><div>${children}</div></div>`;
}

/** Segmented picker. options: [{value,label}] */
export function Segmented({ options, value, onChange, class: cls = '' }) {
  return html`<div class=${'segmented ' + cls} role="tablist">
    ${options.map((o) => html`<button key=${o.value} role="tab" aria-selected=${o.value === value} class=${o.value === value ? 'on' : ''} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
  </div>`;
}

/** Colored status dot; `pulse` is the breathing dot marking genuinely live data. */
export const Dot = ({ color = 'gray', pulse = false }) => html`<span class=${`dot ${color} ${pulse ? 'pulse' : ''}`}></span>`;

/** Section header + rounded card, iOS "insetGrouped". */
export function Section({ title, footer, children }) {
  return html`<div class="list-section">
    ${title && html`<div class="list-header">${title}</div>`}
    <div class="list-card">${children}</div>
    ${footer && html`<div class="list-footer">${footer}</div>`}
  </div>`;
}

/** Navigation bar (inline title) with optional back/leading/trailing items. */
export function NavBar({ title, onBack, backLabel = 'Indietro', leading, trailing }) {
  return html`<div class="navbar">
    <div class="leading">
      ${onBack && html`<button class="nav-btn" onClick=${onBack}><${Icon} name="chevron-left" size=22 strokeWidth=2.4 />${backLabel}</button>`}
      ${leading}
    </div>
    <div class="title ellipsis">${title}</div>
    <div class="trailing">${trailing}</div>
  </div>`;
}

/** Escapes text for the few places that build HTML strings (Leaflet marker/tooltips). */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
