import { html, useState, useEffect, useRef } from '../lib.js';
import { Icon, KIND_ICON } from '../icons.js';
import { api } from '../api.js';

/**
 * "Cerca una fermata o una linea…" — Linee section first, then Fermate, across Cotral and Atac/Roma TPL
 * (port of StopLineSearchBar + MapViewModel.search; the matching itself runs server-side, api/search.php).
 */
export function SearchBar({ onSelectStop, onSelectRoute }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState({ stops: [], routes: [] });
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults({ stops: [], routes: [] }); return undefined; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try { setResults(await api.search(q, { signal: ctrl.signal })); } catch (e) { if (e.name !== 'AbortError') setResults({ stops: [], routes: [] }); }
    }, 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  const clear = () => { setQuery(''); setResults({ stops: [], routes: [] }); inputRef.current?.blur(); setFocused(false); };
  const pick = (fn) => (item) => { clear(); fn(item); };
  const hasResults = results.stops.length || results.routes.length;

  const stopIcon = (s) => (s.source === 'cotral' ? (s.rail ? 'tram-front' : 'bus') : 'map-pin');
  const stopSubtitle = (s) => (s.source === 'cotral' ? (s.rail ? 'Cotral · treno' : 'Cotral') : 'Atac / Roma TPL');
  const routeSubtitle = (r) => [r.source === 'cotral' ? (r.rail ? 'Cotral · treno' : 'Cotral') : r.operator, r.longName].filter(Boolean).join(' · ');

  return html`<div class="search-wrap">
    <div class="search-bar glass-soft">
      <${Icon} name="search" size=18 style=${{ color: 'var(--text-2)' }} />
      <input ref=${inputRef} type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false"
        placeholder="Cerca una fermata o una linea…" value=${query}
        onInput=${(e) => setQuery(e.target.value)} onFocus=${() => setFocused(true)} />
      ${query && html`<button aria-label="Cancella" onClick=${clear} style="display:flex"><${Icon} name="circle-x" size=19 fill=${false} style=${{ color: 'var(--text-2)' }} /></button>`}
    </div>
    ${focused && hasResults ? html`<div class="search-results glass-soft">
      ${results.routes.length > 0 && html`<div class="sr-header">Linee</div>`}
      ${results.routes.map((r) => html`<button key=${r.source + r.id} class="sr-row" onClick=${() => pick(onSelectRoute)(r)}>
        <${Icon} name=${r.source === 'cotral' ? (r.rail ? 'tram-front' : 'bus') : (KIND_ICON[r.kind] ?? 'bus')} size=18 />
        <div class="grow"><div>${r.displayName}</div><div class="t-cap sec">${routeSubtitle(r)}</div></div>
      </button>`)}
      ${results.stops.length > 0 && html`<div class="sr-header">Fermate</div>`}
      ${results.stops.map((s) => html`<button key=${s.source + s.id} class="sr-row" onClick=${() => pick(onSelectStop)(s)}>
        <${Icon} name=${stopIcon(s)} size=18 />
        <div class="grow"><div>${s.name}</div><div class="t-cap sec">${stopSubtitle(s)}</div></div>
      </button>`)}
    </div>` : null}
  </div>`;
}
