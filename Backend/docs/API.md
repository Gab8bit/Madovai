# Madovai Backend — contratto API

Backend Node.js/TypeScript (Fastify) per Madovai: dati statici GTFS, dati live (Cotral, ASTRAL, Atac/Roma TPL) e
promemoria con notifiche push per **web (Web Push)**, **Android (FCM)** e **iOS (APNs, pronto ma spento senza account Apple Developer)**.
È la riscrittura del backend PHP di [`Web/`](../../Web) (`src/`, `public/api/`, `bin/`), che resta il
**riferimento di comportamento**: stessa logica, stessi JSON. Il contratto dettagliato di ogni endpoint è in
[`Web/docs/API.md`](../../Web/docs/API.md) (vale tutto, salvo le differenze sotto).

Documentazione interattiva (OpenAPI 3.1, generata dagli schema delle rotte): `GET /docs`.

## Percorsi

Ogni endpoint esiste con il percorso versionato `/api/v1/<nome>` (da usare nelle app native) e con l'alias legacy
`/api/<nome>.php` (stesso handler, stesso JSON: la PWA Madovai Web può usare questo backend senza modifiche, puntandola al suo indirizzo). Query string identiche.

| v1 | alias legacy | modulo |
|---|---|---|
| `GET /api/v1/stops` | `stops.php` | static |
| `GET /api/v1/search` | `search.php` | static |
| `GET /api/v1/lines` | `lines.php` | static |
| `GET /api/v1/line` | `line.php` | static |
| `GET /api/v1/shapes` | `shapes.php` | static |
| `GET /api/v1/atac-stop` | `atac-stop.php` | static |
| `GET /api/v1/atac-schedule` | `atac-schedule.php` | static |
| `GET /api/v1/pole` | `pole.php` | static |
| `GET /api/v1/rail` | `rail.php` | static (usa ASTRAL dal modulo live) |
| `GET /api/v1/cotral-transits` | `cotral-transits.php` | live |
| `GET /api/v1/cotral-vehicle` | `cotral-vehicle.php` | live |
| `GET /api/v1/cotral-vehicles` | `cotral-vehicles.php` | live |
| `GET /api/v1/astral-line` | `astral-line.php` | live |
| `GET /api/v1/atac-vehicles` | `atac-vehicles.php` | live |
| `GET /api/v1/atac-live` | `atac-live.php` | live |
| `GET /api/v1/atac-trip` | `atac-trip.php` | live |
| `GET /api/v1/push/config` | `push-key.php` (solo `{"publicKey"}` / 503, come in PHP) | push |
| `POST /api/v1/reminders` | `reminders.php` (body con `subscription` al posto di `device`; `?action=unsubscribe`) | push |
| `DELETE /api/v1/devices` | — (legacy: `reminders.php?action=unsubscribe`) | push |
| `POST /api/v1/push/test` | `push-test.php` (body `{subscription}`) | push |
| `GET /health` | — | sistema |

Errori: sempre `{"error":"messaggio in italiano"}` — 400 parametri, 404 risorsa, 429 rate limit, 502 upstream, 503 dati non pronti / push non configurato.
CORS aperto (configurabile con `CORS_ORIGINS`), rate limit per IP sull'API (`RATE_LIMIT_PER_MINUTE`).

## `/line` e `/search` (differenze rispetto al PHP)

La forma delle risposte è quella del PHP. Cambiano l'ordine dei risultati e c'è un campo facoltativo in più.

**`GET /api/v1/line`**: per Atac e bus Cotral `stops` è **in ordine di percorso**, non più alfabetico (Atac) o per id (Cotral bus).
Contiene le stesse fermate di prima, ciascuna una volta sola, con lo stesso `headsign`. L'ordine si costruisce così:
1. Per ogni `direction_id` la corsa rappresentativa è quella con più fermate. A parità vince quella con la shape più frequente in quella direzione, poi la prima in `trips.txt`.
2. Prima vengono le fermate della direzione 0, nell'ordine di `stop_sequence` della sua corsa rappresentativa.
3. Poi, in coda, le fermate presenti solo nelle corse rappresentative delle altre direzioni, nel loro ordine.
4. Infine le fermate presenti solo in altre corse (diramazioni, corse limitate, deviazioni), subito dopo la fermata che le precede in quella corsa. Se non ce n'è una, prima della fermata che le segue; altrimenti in coda.

Le metro (MEA, MEB, MEB1, MEC) escono nell'ordine reale delle stazioni: prima tutta la direzione 0, poi la 1, perché le banchine hanno `stop_id` diversi.
Campo facoltativo `directions: [{directionId, headsign, stopIds}]`: la sequenza della corsa rappresentativa di ogni direzione (`headsign` solo Atac, `null` per Cotral).
I treni Cotral (`F:…`) sono invariati (corsa più lunga) e non hanno `directions`.

**`GET /api/v1/search`**:
- **Normalizzazione:** maiuscole/minuscole, accenti e punteggiatura (`| / - , ( ) . '` e simili) vengono ignorati, gli spazi multipli compressi.
- **Corrispondenza:** un nome corrisponde se contiene **tutte** le parole, in qualsiasi ordine. Le linee si confrontano su `shortName`, `longName` **e** `displayName` ("Metro A" → MEA).
- **Ordine dei risultati:**
  1. nome identico;
  2. nome che inizia con la ricerca;
  3. tutte le parole all'inizio di una parola del nome (prima i nomi che contengono la frase intera, poi quelli con le parole sparse);
  4. il resto.

  A parità di questi criteri viene prima il nome più corto, poi Cotral prima di Atac, poi l'ordine di prima (fermate in ordine di file, linee per `shortName`).
- **Limiti:** invariati, max 15 fermate Cotral + 15 Atac e max 10 linee Cotral + 10 Atac. Le due fonti però sono unite per rilevanza, non più tutta Cotral e poi tutta Atac.
- **Prestazioni:** l'indice (nomi già normalizzati) è in memoria, costruito una volta per ogni versione del database (circa 25 ms all'avvio). Una ricerca impiega circa 1 ms.

## Dispositivi e promemoria (novità rispetto al PHP)

Il PHP conosceva solo le sottoscrizioni Web Push. Qui un promemoria appartiene a un **dispositivo**, di tre tipi:

```jsonc
{"type":"webpush","subscription":{"endpoint":"https://…","keys":{"p256dh":"…","auth":"…"}}}
{"type":"fcm","token":"<registration token FCM>"}                       // Android
{"type":"apns","token":"<64 hex>","environment":"sandbox"|"production"}  // iOS (spento finché non si configura APNs)
```

- `GET /api/v1/push/config` → `{"webPush":{"publicKey":"…"}|null,"fcm":{"enabled":bool},"apns":{"enabled":bool,"topic":str|null}}`.
  Le chiavi VAPID vengono **generate automaticamente** al primo avvio in `DATA_DIR/vapid.json` (niente più `gen-vapid`).
- `POST /api/v1/reminders` body `{"device":Device,"reminders":[Reminder…]}` → sostituisce tutti i promemoria del dispositivo,
  `{"ok":true,"count":n}`. Stesse regole del PHP: validazione rigida, max 30 promemoria, stato conservato se id+orario+sorgente
  invariati, nessuna esecuzione retroattiva oggi. 503 se il tipo di dispositivo non è configurato (FCM/APNs senza credenziali).
- `DELETE /api/v1/devices` body `{"device":Device}` → elimina dispositivo e promemoria.
- `POST /api/v1/push/test` body `{"device":Device}` → notifica di prova sincrona (stesse risposte e rate limit 30 s del PHP).
- `Reminder` identico al PHP (weekdays 1 = domenica … 7 = sabato, ora di Roma).
- Payload della notifica per tutti i canali: `title`, `body`, `tag` (= id promemoria), `url` (`./#/promemoria`; le app native lo ignorano).
- Token rifiutati come non più validi (Web Push 404/410, FCM `UNREGISTERED`/404, APNs 410 / `BadDeviceToken`) → dispositivo eliminato.

Scheduler: dentro il processo (niente cron), ogni minuto allineato, stessa logica di `ReminderRunner.php` (finestra di tolleranza,
retry dopo 2 minuti fino a 15 volte, poi rinuncia fino al giorno successivo, chain abbandonata dopo 60 minuti).

## Dati statici

- Schema di `DATA_DIR/madovai.sqlite`: quello del PHP (`Web/docs/API.md` sezione "Schema" + `src/Gtfs/Builder.php`) più,
  dalla **versione 2** dello schema (`meta.schema_version = '2'`), l'ordine di percorso precalcolato dal builder:
  ```
  atac_route_stops(route_id, pos INT, stop_id, PRIMARY KEY(route_id,pos)) WITHOUT ROWID             -- tutte le fermate della linea in ordine
  atac_route_directions(route_id, direction_id INT, headsign NULL, stop_ids TEXT /* JSON */, PRIMARY KEY(route_id,direction_id)) WITHOUT ROWID
  cotral_route_stops / cotral_route_directions                                                         -- idem per i bus Cotral (headsign sempre NULL)
  ```
  Il builder le ricava da `stop_times.txt` riducendo ogni corsa al suo schema di fermate (le corse uguali sono salvate una
  volta sola: circa 1.200 schemi Atac e 5.200 Cotral), quindi senza tenere in memoria i milioni di righe.
  La build dura come prima (circa 10 s) e il database cresce di circa 4 MB (113 → 117 MB).
- **Aggiornamento dello schema:** all'avvio, se `madovai.sqlite` ha uno schema più vecchio di quello del codice (`SCHEMA_VERSION` in `src/gtfs/builder.ts`),
  il backend lo ricostruisce subito in background. Nel frattempo il file vecchio continua a rispondere: `/line` resta in ordine
  alfabetico e senza `directions` finché la build non finisce. Non serve nessun intervento manuale. Per forzarla: `npm run build-data`
  (nel container: `docker compose exec madovai-backend node dist/cli/build-data.js`).
- Il build gira in un **worker thread** (l'API resta reattiva), scrive in un file temporaneo e lo sostituisce con `rename` atomico;
  `db.gtfs()` riapre da solo il file nuovo (controlla l'inode).
- Al primo avvio, se il database manca, viene costruito subito (gli endpoint statici rispondono 503 finché non è pronto);
  poi ogni giorno all'ora `GTFS_REBUILD_AT` (default `04:30`, ora di Roma). CLI: `npm run build-data` (anche `--from-dir=DIR`).

## Interfacce TypeScript tra moduli

```ts
// src/live/astral.ts (modulo live) — usato da static per /rail
export async function astralDepartures(route: string, stationName: string): Promise<{ destination: string; route: string; entries: Entry[] } | null>;
// src/live/departureStatus.ts (modulo live) — usato da push per i promemoria
export async function departureStatus(reminder: Reminder): Promise<{ time: string; delayMinutes: number | null; isCancelled: boolean; nextUsefulTime: string | null } | null>;
// src/gtfs/jobs.ts (modulo static)
export function startGtfsJobs(log: FastifyBaseLogger): () => void;
// src/push/scheduler.ts (modulo push)
export function startReminderScheduler(log: FastifyBaseLogger): () => void;
```
Tipi condivisi (`Entry`, `Reminder`, `Device`, `Route`, `Stop`…) in `src/types.ts`.

## Configurazione (variabili d'ambiente)

Vedi `.env.example`. `DATA_DIR`, `PORT`, `CORS_ORIGINS`, `GTFS_REBUILD_AT`, `REMINDERS_ENABLED`,
`VAPID_SUBJECT`, `FCM_SERVICE_ACCOUNT_FILE`, `APNS_KEY_FILE`/`APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_TOPIC`/`APNS_PRODUCTION`.
