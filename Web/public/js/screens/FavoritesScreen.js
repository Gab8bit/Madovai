import { html, useState } from '../lib.js';
import { Icon } from '../icons.js';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { favoritesStore, favoriteName, favoriteSubtitle } from '../favorites.js';
import { Section, NavBar, EmptyState } from '../ui/components.js';
import { PoleSheetModal } from './PoleSheet.js';
import { AtacStopSheetModal } from './AtacSheets.js';

/**
 * "Preferiti" tab — a unified list of Cotral poles and Atac/Roma TPL stops, each opening the very same detail
 * sheet that tapping it on the map or in "Linee" would, so there's only one schedule view per stop kind.
 */
export function FavoritesScreen({ active }) {
  const items = useStore(favoritesStore);
  const [pole, setPole] = useState(null);
  const [atac, setAtac] = useState(null);

  const select = async (item) => {
    if (item.kind === 'cotral') { setPole(item.pole); return; }
    // Resolve back to every platform sharing this stop's name (not just the one favorited), like a bare map-pin tap.
    try {
      const data = await api.atacStop(item.stop.id);
      setAtac({ stops: data.stops?.length ? data.stops : [{ ...item.stop, headsign: null }] });
    } catch { setAtac({ stops: [{ ...item.stop, headsign: null }] }); }
  };

  const icon = (item) => (item.kind === 'cotral' ? (item.pole.rail ? 'tram-front' : 'bus') : 'locate-fixed');

  return html`<div class=${'tab-screen ' + (active ? 'active' : '')}>
    <div class="navscreen">
      <${NavBar} title="Preferiti" />
      ${items.length === 0
        ? html`<${EmptyState} icon="star" title="Nessun preferito" message="Tocca la stella su una fermata o palina per salvarla qui." />`
        : html`<div class="scroll big-top"><${Section}>
            ${items.map((item) => html`<button key=${item.id} class="list-row" onClick=${() => select(item)}>
              <${Icon} name=${icon(item)} size=20 style=${{ color: 'var(--text-2)' }} />
              <div class="grow col" style="gap:2px"><div>${favoriteName(item)}</div>${favoriteSubtitle(item) && html`<div class="t-cap sec">${favoriteSubtitle(item)}</div>`}</div>
              <${Icon} name="chevron-right" size=16 class="chevron" />
            </button>`)}
          <//></div>`}
    </div>
    ${pole && html`<${PoleSheetModal} key=${pole.code} pole=${pole} onClose=${() => setPole(null)} />`}
    ${atac && html`<${AtacStopSheetModal} key=${atac.stops[0].id} stops=${atac.stops} routeId=${null} onClose=${() => setAtac(null)} />`}
  </div>`;
}
