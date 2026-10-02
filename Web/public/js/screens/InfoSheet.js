import { html } from '../lib.js';
import { Icon } from '../icons.js';
import { Sheet } from '../ui/Sheet.js';
import { NavBar, Section } from '../ui/components.js';
import { useSheet } from '../ui/Sheet.js';
import { APP_VERSION } from '../version.js';

export function InfoSheetModal({ onClose }) {
  return html`<${Sheet} onClose=${onClose} detents=${['large']} initial="large" form=${true}><${InfoSheet} /><//>`;
}

function InfoRow({ icon, title, text }) {
  return html`<div class="list-row" style="align-items:flex-start;padding:12px 16px">
    <${Icon} name=${icon} size=20 style=${{ color: 'var(--tint)', marginTop: '1px' }} />
    <div><div class="t-sub semibold">${title}</div><div class="t-foot sec" style="margin-top:2px">${text}</div></div>
  </div>`;
}

function LegendRow({ color, icon, label }) {
  return html`<div class="list-row" style="min-height:40px;padding:8px 16px">
    <div class="legend-dot" style=${{ background: color }}>${icon && html`<${Icon} name=${icon} size=12 strokeWidth=2.6 />`}</div>
    <div class="t-sub">${label}</div>
  </div>`;
}

export function InfoSheet() {
  const { close } = useSheet();
  return html`<div class="navscreen" style="background:var(--bg)">
    <${NavBar} title="Info" trailing=${html`<button class="nav-btn" style="font-weight:600" onClick=${close}>Fine</button>`} />
    <div class="scroll in-sheet big-top">
      <${Section} title="Come funziona">
        <${InfoRow} icon="map" title="Due fonti, una mappa" text="Cotral copre l'extraurbano del Lazio, Atac e Roma TPL coprono Roma urbana (bus, tram, metro). Sono fonti indipendenti, mostrate insieme." />
        <${InfoRow} icon="scan-line" title="Copertura dei veicoli in tempo reale" text="Puoi vedere sulla mappa la posizione in tempo reale dei veicoli Atac e Cotral. Alcuni mezzi non hanno la geolocalizzazione attiva, quindi potrebbero non essere mostrati ma comunque calcolati nelle tabelle di marcia." />
        <${InfoRow} icon="mouse-pointer-click" title="Tocca un veicolo" text="Filtra la mappa al solo percorso e ai mezzi di quella linea, e apre l'orario. Per Atac/Roma TPL è l'orario completo della corsa; per Cotral solo le info disponibili. Il pulsante col cerchio e la X in basso riporta alla vista normale." />
      <//>

      <${Section} title="Simboli sulla mappa">
        <${LegendRow} color="var(--blue)" icon="bus" label="Palina Cotral (bus)" />
        <${LegendRow} color="var(--indigo)" icon="tram-front" label="Stazione Cotral (treno/Roma Lido ecc.)" />
        <${LegendRow} color="var(--yellow)" icon="star" label="Palina preferita" />
        <${LegendRow} color="var(--orange)" icon=${null} label="Fermata Atac / Roma TPL" />
        <${LegendRow} color="var(--teal)" icon="bus" label="Bus Atac in movimento" />
        <${LegendRow} color="var(--red)" icon="metro" label="Metro Atac in movimento" />
        <${LegendRow} color="var(--green)" icon="bus" label="Mezzo Roma TPL in movimento" />
        <${LegendRow} color="var(--orange)" icon="bus" label="Veicolo Cotral in movimento" />
      <//>

      <${Section} title="Crediti">
        <div class="pad"><div class="t-sub semibold">Dati trasporto Roma</div><div class="t-foot sec" style="margin-top:4px">Roma Servizi per la Mobilità — romamobilita.it, licenza CC-BY 3.0 Italia.</div></div>
        <div class="pad" style="border-top:0.5px solid var(--sep)"><div class="t-sub semibold">Dati Cotral</div><div class="t-foot sec" style="margin-top:4px">Endpoint e feed GTFS pubblici di Cotral S.p.A. Orari e ritardi dei treni: ASTRAL S.p.A.</div></div>
        <div class="pad" style="border-top:0.5px solid var(--sep)"><div class="t-sub semibold">Versione</div><div class="t-foot sec" style="margin-top:4px">Madovai Web ${APP_VERSION}</div></div>
        <div class="pad" style="border-top:0.5px solid var(--sep)"><div class="t-sub semibold">Mappa</div><div class="t-foot sec" style="margin-top:4px">© OpenStreetMap contributors (openstreetmap.org/copyright).</div></div>
      <//>
    </div>
  </div>`;
}
