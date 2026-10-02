import { html, useState, useEffect, useRef } from '../lib.js';
import { Icon } from '../icons.js';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { remindersStore, reminders, reminderTimeLabel, reminderDaysLabel, reminderIsTrain, runSync } from '../reminders.js';
import { ensureSubscription, pushCapability, currentSubscription, sendTestPush, PushError } from '../push.js';
import { Sheet, useSheet } from '../ui/Sheet.js';
import { Section, NavBar, EmptyState, InfoLabel } from '../ui/components.js';
import { trainRoute, trainDirectionsForGtfs, WEEKDAYS_MONDAY_FIRST } from '../models.js';
import { uuid } from '../util.js';

/** The "Promemoria" tab — same self-contained shape as Preferiti: its own nav bar, a list, tap to edit, swipe to delete. */
export function RemindersScreen({ active }) {
  const { reminders: list } = useStore(remindersStore);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  return html`<div class=${'tab-screen ' + (active ? 'active' : '')}>
    <div class="navscreen">
      <${NavBar} title="Promemoria" trailing=${html`<button class="nav-btn" aria-label="Nuovo promemoria" onClick=${() => setCreating(true)}><${Icon} name="plus" size=24 strokeWidth=2.4 /></button>`} />
      <div class="scroll big-top">
        <${NotificationsCard} hasReminders=${list.length > 0} active=${active} />
        ${list.length === 0
          ? html`<${EmptyState} fill=${false} icon="bell" title="Nessun promemoria" message="Crea un promemoria per ricevere una notifica sul prossimo bus o treno all'orario che scegli." />`
          : html`<${Section}>${list.map((r) => html`<${SwipeRow} key=${r.id} onTap=${() => setEditing(r)} onDelete=${() => reminders.remove(r.id)}>
              <div class="list-row" style="background:var(--bg-elev)">
                <${Icon} name=${reminderIsTrain(r) ? 'tram-front' : 'bus'} size=20 style=${{ color: 'var(--text-2)' }} />
                <div class="grow col" style="gap:2px">
                  <div>${r.stopName}</div>
                  ${r.source.type === 'cotralTrain' && trainRoute(r.source.route) && html`<div class="t-cap sec">${trainRoute(r.source.route).label}</div>`}
                  <div class="t-cap sec">${reminderDaysLabel(r)} · ${reminderTimeLabel(r)}</div>
                </div>
                <${Icon} name="chevron-right" size=16 class="chevron" />
              </div>
            <//>`)}<//>`}
      </div>
    </div>
    ${editing && html`<${ReminderFormModal} key=${editing.id} editing=${editing} onClose=${() => setEditing(null)} />`}
    ${creating && html`<${ReminderFormModal} editing=${null} onClose=${() => setCreating(false)} />`}
  </div>`;
}

/**
 * Swipe-left-to-delete row ("Elimina" — explicit label, the app is all-Italian). Horizontal drags move the row; vertical
 * ones are left to the browser's own scrolling (touch-action: pan-y).
 */
function SwipeRow({ children, onTap, onDelete }) {
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const st = useRef(null);
  const OPEN = -88;

  const down = (e) => { st.current = { sx: e.clientX, sy: e.clientY, base: x, locked: null, moved: false }; };
  const move = (e) => {
    const s = st.current;
    if (!s) return;
    const dx = e.clientX - s.sx, dy = e.clientY - s.sy;
    if (!s.locked) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { s.locked = 'h'; setDragging(true); e.currentTarget.setPointerCapture?.(e.pointerId); }
      else if (Math.abs(dy) > 8) { s.locked = 'v'; }
    }
    if (s.locked === 'h') { s.moved = true; setX(Math.max(OPEN - 24, Math.min(0, s.base + dx))); }
  };
  const up = () => {
    const s = st.current;
    st.current = null;
    setDragging(false);
    if (!s) return;
    if (s.moved) { setX(x < OPEN / 2 ? OPEN : 0); return; }
    if (s.locked === 'v') return;
    if (x !== 0) setX(0); else onTap();
  };

  return html`<div class=${'swipe-wrap ' + (dragging ? 'dragging' : '')}>
    <button class="swipe-action" onClick=${onDelete} tabindex=${x < 0 ? 0 : -1}>Elimina</button>
    <div class="swipe-content" style=${{ transform: `translateX(${x}px)`, touchAction: 'pan-y' }}
      onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>${children}</div>
  </div>`;
}

/** Web Push status — the web counterpart of iOS's notification permission prompt, but it has to be explicit and visible. */
function NotificationsCard({ hasReminders, active }) {
  const { sync } = useStore(remindersStore);
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const cap = pushCapability();

  const refresh = async () => { try { setSub(await currentSubscription()); } catch { setSub(null); } };
  useEffect(() => { if (active) refresh(); }, [active, sync.status]);

  const enable = async () => {
    setBusy(true); setNote('');
    try { await ensureSubscription(); await runSync(); await refresh(); }
    catch (e) { setNote(e instanceof PushError ? e.message : e.message); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setNote('');
    try { const r = await sendTestPush(); setNote(r?.ok === false ? 'Sottoscrizione non più valida: riattiva le notifiche.' : 'Notifica di prova inviata.'); }
    catch (e) { setNote(e.message); }
    finally { setBusy(false); }
  };

  let body;
  if (!cap.supported && !cap.needsInstall) {
    body = html`<${InfoLabel} icon="bell-off">Questo browser non supporta le notifiche push: i promemoria non potranno avvisarti.<//>`;
  } else if (cap.needsInstall) {
    body = html`<${InfoLabel} icon="smartphone">Su iPhone le notifiche funzionano solo se aggiungi Madovai alla schermata Home: tocca Condividi → "Aggiungi alla schermata Home", poi apri l'app da lì.<//>`;
  } else if (cap.permission === 'denied') {
    body = html`<${InfoLabel} icon="bell-off">Le notifiche sono bloccate per questo sito. Abilitale dalle impostazioni del browser per ricevere i promemoria.<//>`;
  } else if (!sub) {
    body = html`<div class="row" style="gap:12px;align-items:center">
      <div class="grow"><${InfoLabel} icon="bell">Attiva le notifiche per ricevere i promemoria all'orario scelto.<//></div>
      <button class="btn btn-prominent" disabled=${busy} onClick=${enable}>Attiva</button></div>`;
  } else {
    body = html`<div class="row" style="gap:12px;align-items:center">
      <div class="grow"><${InfoLabel} icon="bell-ring">Notifiche attive${sync.status === 'error' ? ' — sincronizzazione non riuscita, riprovo al prossimo salvataggio' : ''}.<//></div>
      <button class="btn btn-bordered small" disabled=${busy} onClick=${test}>Prova</button></div>`;
  }

  return html`<${Section} footer=${html`Il controllo avviene sul server all'orario scelto, quindi non serve tenere aperta l'app. Se il controllo non riesce, riprova ogni 2 minuti per un massimo di 15 volte, senza avvisarti.`}>
    <div class="pad">${body}${note && html`<div class="t-cap sec" style="margin-top:8px">${note}</div>`}</div>
  <//>`;
}

// ───────────────────────── Form ─────────────────────────

export function ReminderFormModal({ editing, onClose }) {
  return html`<${Sheet} onClose=${onClose} detents=${['large']} initial="large" form=${true}><${ReminderForm} editing=${editing} /><//>`;
}

function ReminderForm({ editing }) {
  const { close } = useSheet();
  const [stopName, setStopName] = useState(editing?.stopName ?? '');
  const [source, setSource] = useState(editing?.source ?? null);
  const [candidates, setCandidates] = useState(() => (editing?.source.type === 'cotralTrain' ? (trainDirectionsForGtfs(trainRoute(editing.source.route)?.gtfs)) : []));
  const [weekdays, setWeekdays] = useState(() => new Set(editing?.weekdays ?? []));
  const [time, setTime] = useState(() => {
    if (editing) return `${String(editing.hour).padStart(2, '0')}:${String(editing.minute).padStart(2, '0')}`;
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [metroHidden, setMetroHidden] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); setMetroHidden(false); return undefined; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await api.search(q, { signal: ctrl.signal });
        // Atac metro has no per-stop live data in either GTFS-RT feed, so reminders can't target it.
        const stops = res.stops ?? [];
        const usable = stops.filter((s) => !(s.source === 'atac' && s.metro));
        setMetroHidden(usable.length < stops.length);
        setResults(usable);
      } catch (e) { if (e.name !== 'AbortError') setResults([]); }
    }, 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  const choose = async (s) => {
    setStopName(s.name);
    setQuery(''); setResults([]);
    if (s.source === 'cotral' && s.rail) {
      try {
        const pole = await api.pole(s.id);
        const list = pole.trainRoutes ?? [];
        setCandidates(list);
        setSource(list.length ? { type: 'cotralTrain', stationName: s.name, route: list[0] } : null);
      } catch { setCandidates([]); setSource(null); }
    } else if (s.source === 'cotral') {
      setCandidates([]); setSource({ type: 'cotralBus', poleCode: s.id });
    } else {
      setCandidates([]); setSource({ type: 'atacStop', stopId: s.id });
    }
  };

  const toggleDay = (id) => setWeekdays((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const canSave = !!source && weekdays.size > 0 && /^\d{2}:\d{2}$/.test(time);

  const save = () => {
    if (!canSave) return;
    const [hour, minute] = time.split(':').map(Number);
    const reminder = { id: editing?.id ?? uuid(), stopName, weekdays: [...weekdays].sort((a, b) => a - b), hour, minute, source };
    editing ? reminders.update(reminder) : reminders.add(reminder);
    // Asked right after the first save (not at launch), and straight from this click so the browser allows the prompt —
    // exactly the "contextual" permission request the iOS app does. Failures are shown in the tab's Notifiche card.
    ensureSubscription().then(runSync).catch(() => runSync());
    close();
  };

  const stationName = source?.type === 'cotralTrain' ? source.stationName : null;

  return html`<div class="navscreen" style="background:var(--bg)">
    <${NavBar} title=${editing ? 'Modifica promemoria' : 'Nuovo promemoria'}
      leading=${html`<button class="nav-btn" onClick=${close}>Annulla</button>`}
      trailing=${html`<button class=${'nav-btn ' + (canSave ? '' : 'disabled')} style="font-weight:600" onClick=${save}>Salva</button>`} />
    <div class="scroll in-sheet big-top">
      <${Section} title="Fermata">
        ${source
          ? html`<div class="list-row"><span class="grow">${stopName}</span><button class="btn-link t-cap" onClick=${() => { setSource(null); setStopName(''); setCandidates([]); }}>Cambia</button></div>`
          : html`<input class="form-field" placeholder="Cerca una fermata…" autocomplete="off" autocorrect="off" spellcheck="false" value=${query} onInput=${(e) => setQuery(e.target.value)} />
              ${metroHidden && html`<div class="pad" style="padding-top:0"><${InfoLabel}>Dati in tempo reale non disponibili per la metro.<//></div>`}
              ${results.map((s) => html`<button key=${s.source + s.id} class="list-row" onClick=${() => choose(s)}>
                <${Icon} name=${s.source === 'cotral' ? (s.rail ? 'tram-front' : 'bus') : 'map-pin'} size=18 style=${{ color: 'var(--text-2)' }} />
                <div class="grow col" style="gap:1px"><div>${s.name}</div><div class="t-cap2 sec">${s.source === 'cotral' ? (s.rail ? 'Cotral · treno' : 'Cotral') : 'Atac / Roma TPL'}</div></div>
              </button>`)}`}
      <//>

      ${candidates.length > 1 && stationName && html`<${Section} title="Direzione">
        <div class="pad"><select class="select" value=${source.route} onChange=${(e) => setSource({ type: 'cotralTrain', stationName, route: e.target.value })}>
          ${candidates.map((c) => html`<option value=${c} selected=${c === source.route}>${trainRoute(c)?.label ?? c}</option>`)}
        </select></div>
      <//>`}

      <${Section} title="Giorni">
        <div class="chips">${WEEKDAYS_MONDAY_FIRST.map((d) => html`<button key=${d.id} class=${'chip ' + (weekdays.has(d.id) ? 'on' : '')} aria-pressed=${weekdays.has(d.id)} onClick=${() => toggleDay(d.id)}>${d.label}</button>`)}</div>
      <//>

      <${Section} title="Orario">
        <div class="pad"><input class="time-input" type="time" value=${time} onInput=${(e) => setTime(e.target.value)} /></div>
      <//>

      <${Section}>
        <div class="pad"><${InfoLabel}>Riceverai una notifica all'orario scelto con il prossimo passaggio e il suo stato (puntuale, in ritardo o soppresso). Il controllo avviene sul server: l'app non deve restare aperta. Servono le notifiche attive; su iPhone solo con Madovai aggiunta alla schermata Home.<//></div>
      <//>

      ${editing && html`<${Section}><button class="list-row btn-destructive" style="justify-content:center" onClick=${() => { reminders.remove(editing.id); close(); }}>Elimina promemoria</button><//>`}
    </div>
  </div>`;
}
