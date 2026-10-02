import { html, render, useState, useEffect } from './lib.js';
import { Icon } from './icons.js';
import { MapScreen } from './screens/MapScreen.js';
import { LineeScreen } from './screens/LineeScreen.js';
import { FavoritesScreen } from './screens/FavoritesScreen.js';
import { RemindersScreen } from './screens/RemindersScreen.js';

const TABS = [
  { id: 'map', label: 'Mappa', icon: 'map', fill: false },
  { id: 'linee', label: 'Linee', icon: 'list', fill: false },
  { id: 'preferiti', label: 'Preferiti', icon: 'star', fill: true },
  { id: 'reminders', label: 'Promemoria', icon: 'bell', fill: true },
];

/**
 * Four top-level sections in a bottom bar with the "liquid glass" material (CSS approximation of iOS 26's tab bar:
 * blur + saturation + specular edge). All four screens stay mounted — like SwiftUI's TabView — so the map keeps its
 * position and the lists keep their scroll while another tab is showing.
 */
function App() {
  const [tab, setTab] = useState(() => {
    const hash = location.hash.replace('#/', '');
    return TABS.some((t) => t.id === hash) || hash === 'promemoria' ? (hash === 'promemoria' ? 'reminders' : hash) : 'map';
  });
  // A notification tap while the app is already open only changes the hash (e.g. "#/promemoria").
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace('#/', '');
      const next = h === 'promemoria' ? 'reminders' : h;
      if (TABS.some((t) => t.id === next)) setTab(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { history.replaceState(null, '', tab === 'map' ? location.pathname + location.search : `#/${tab}`); }, [tab]);

  return html`
    <${MapScreen} active=${tab === 'map'} />
    <${LineeScreen} active=${tab === 'linee'} />
    <${FavoritesScreen} active=${tab === 'preferiti'} />
    <${RemindersScreen} active=${tab === 'reminders'} />
    <nav class="tabbar glass" role="tablist" aria-label="Sezioni">
      ${TABS.map((t) => html`<button key=${t.id} class=${'tab ' + (tab === t.id ? 'active' : '')} role="tab" aria-selected=${tab === t.id} onClick=${() => setTab(t.id)}>
        <${Icon} name=${t.icon} size=24 fill=${t.fill && tab === t.id} strokeWidth=${tab === t.id ? 2.2 : 1.9} />
        <span>${t.label}</span>
      </button>`)}
    </nav>`;
}

render(html`<${App} />`, document.getElementById('app'));
const boot = document.getElementById('boot');
if (boot) { boot.classList.add('done'); setTimeout(() => boot.remove(), 400); }

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* HTTP / unsupported: the app works without it */ }); });
}
