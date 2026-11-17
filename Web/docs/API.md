> **Documento storico.** Descrive il backend PHP di questo progetto (`src/`, `public/api/`, `bin/`), non più usato in produzione dalla v1.1.0 della PWA.
> Il backend attuale è `~/Git-Projects/Madovai-Backend` (Node.js/Fastify, endpoint `/api/v1/…`): il suo contratto è nel suo `docs/API.md`, che rimanda a questo
> file per il dettaglio di ogni endpoint (stessa logica, stessi JSON), salvo le differenze lì elencate (dispositivi push, `push/config`, `DELETE /devices`).

# Madovai Web — contratto API e dati

Porting web di **Madovai-iOS** (`~/Git-Projects/Madovai-iOS`, sorgenti Swift = riferimento di comportamento).
Stesse funzioni, stessa UI. Questo documento è il contratto tra backend PHP e frontend JS.

## Architettura

```
Browser (PWA statica, Preact+htm, Leaflet)
   │  fetch JSON
   ▼
public/api/*.php  ──►  src/ (PHP 8.1+, nessuna dipendenza, nessun Composer)
                         ├─ Live/   client verso Cotral (XML), ASTRAL (JSON), Roma Mobilità (GTFS-RT protobuf)
                         ├─ Gtfs/   lettura del DB statico
                         └─ Push/   Web Push (VAPID, RFC 8291) + promemoria
data/madovai.sqlite   GTFS statici pre-elaborati (bin/build-data.php, da cron giornaliero)
data/state.sqlite     sottoscrizioni push + promemoria
data/cache/           cache file dei feed live (stampede-safe, vedi src/Cache.php)
```

Perché un backend: Cotral risponde solo in HTTP e senza CORS (una pagina HTTPS non può chiamarlo),
i GTFS pesano 235 MB (Atac) e 175 MB (Cotral bus), e il GTFS-Realtime va decodificato e messo in cache una volta per tutti.

Infrastruttura condivisa già pronta (NON riscriverla): `src/bootstrap.php` (autoload `Madovai\…`),
`Config`, `Http`, `Cache`, `Json`, `Db`, `Rome`. Ogni endpoint è:

```php
<?php
declare(strict_types=1);
require __DIR__ . '/../../src/bootstrap.php';
use Madovai\Json;
Json::run(function () { /* ... */ return $data; }, 10 /* max-age s, opzionale */);
```

Convenzioni:
- JSON UTF-8. Errori: `{"error":"msg"}` con HTTP 400/502/503 (gestiti da `Json::run`). Dati statici mancanti → `NotReady` (503).
- Orari "HH:MM" = ora di Roma. Timestamp `ts` = secondi unix UTC. Tutto ciò che è "adesso" usa `Rome::now()`.
- ID: stop Cotral = `stop_id` GTFS grezzo ("1021", "RL_ACILIA"); route Cotral treno = `"F:"+route_id`, bus = `route_id` grezzo.
  Atac: ID GTFS grezzi. Una `route` espone sempre `source` (`"cotral"|"atac"`).
- `kind` ∈ `"bus" | "tram" | "metro" | "treno"` (GTFS route_type 3/0/1/2). `operator` ∈ `"Cotral"|"Atac"|"Roma TPL"`
  (Atac solo se `agency_id == "OP1"`, tutti gli altri Roma TPL).
- Polilinee: *Encoded Polyline Algorithm* (Google), precisione 5, stringa. `bbox = [minLat,minLon,maxLat,maxLon]`.
- Gli endpoint "live" non devono mai restituire dati inventati: se l'upstream non risponde e non c'è cache → 502.

## Oggetti ricorrenti

```jsonc
// Route (search, lines, line)
{"source":"atac","id":"211","shortName":"211","longName":"…","displayName":"211","kind":"bus","operator":"Atac","color":"FF6600"|null,"rail":false}
//  displayName: "Metro A/B/B1/C" per route_id MEA/MEB/MEB1/MEC (long name vuoto nel feed), altrimenti longName||shortName per Atac;
//               shortName per Cotral. longName Cotral: senza il suffisso " # CODICE" finale.

// Stop (search)
{"source":"cotral"|"atac","id":"1021","name":"ARTENA | Campo Sportivo","lat":41.74,"lon":12.91,"rail":false,"metro":false /* solo Atac */}
//  Cotral name = stop_name senza il suffisso " #\s*\w+$"; locality = parte prima di | ! (
//  "metro":bool è presente solo per gli stop Atac: true sse la fermata è servita da una route metro (MEA/MEB/MEB1/MEC via atac_stop_routes), come ReminderFormView.metroStopIds.

// Entry di un orario ferroviario (ASTRAL o fallback GTFS)
{"id":"RL2173","time":"05:15","sortSeconds":18900,"delayMinutes":2|null,"isCancelled":false,"isReplacementBus":false}
```

## Endpoint statici (leggono data/madovai.sqlite)

| Endpoint | Risposta |
|---|---|
| `GET api/stops.php?minLat&minLon&maxLat&maxLon[&cotralLimit=150][&atacLimit=400]` | `{"cotral":[{"id","name","locality","lat","lon","rail"}],"atac":[{"id","name","lat","lon"}]}` — stop dentro il bbox (iOS: 60/300 in ordine di file; qui limiti più larghi, ordinati per vicinanza al centro del bbox). |
| `GET api/search.php?q=` | `{"stops":[Stop…],"routes":[Route…]}` — contains case-insensitive. Stop: prima Cotral (max 15) poi Atac (max 15). Route: Cotral (max 10, ordinate per shortName) poi Atac (max 10, idem). Match su nome stop; su shortName **o** longName per le route. q vuota → liste vuote. |
| `GET api/lines.php` | `{"atac":[Route…],"cotralRail":[Route…]}` — tutte le route Atac (ordinate per shortName) + le route treno Cotral (`F:`). Cache 1h. |
| `GET api/line.php?source=atac\|cotral&id=ID` | `{"route":Route,"stops":[{"id","name","lat","lon","headsign":str\|null}],"shapes":[{"id","coords":"<polyline>","bbox":[…]}]}`. Atac: stop con membership esatto (ordinati per nome), headsign = `atac_stop_headsign(route,stop)`. Cotral treno (`F:…`): stop **in ordine fisico di linea** (trip più lungo della route, come `stopsForRouteInOrder`) + shapes della linea. Cotral bus: stop senza ordine, `shapes:[]`. 404→400 se la route non esiste. |
| `GET api/shapes.php?minLat&minLon&maxLat&maxLon[&limit=150]` | `{"shapes":[{"id","routeId","kind","color":str\|null,"coords":"<polyline>","bbox":[…]}]}` — shape Atac (una per shape_id distinto) il cui bbox interseca il riquadro (port di `shapesInRegion`), max `limit`. Per il toggle "linee" della mappa. |
| `GET api/atac-stop.php?id=STOPID[&route=ROUTEID]` | `{"name","stops":[{"id","name","lat","lon","headsign":str\|null}]}` — tutte le piattaforme con lo stesso nome (trim), ordinate per stop_id (= `stopsSharingName`). headsign: con `route` → `atac_stop_headsign`, altrimenti un qualsiasi headsign di quella piattaforma. |
| `GET api/atac-schedule.php?stop=STOPID` | `[{"tripId","routeId","routeLabel","kind","ts","headsign"}]` — fallback "orari stimati" (port di `AtacGtfsStore.scheduledDepartures`): service attivi oggi (Roma) × partenze ≥ adesso, max 6, ordinate. |
| `GET api/pole.php?id=STOPID` | `{"id","name","locality","lat","lon","rail":bool,"trainRoutes":["RL_CC-PSP","RL_PSP-CC"]}` — palina Cotral statica. `trainRoutes` = codici `CotralTrainRoute` candidati (da `route_short_name` ROMALIDO/RVURB/RVEXT delle route `F:` che servono lo stop; vedi `CotralTrainRoute.directions(forGTFSRouteShortName:)`), `[]` per i bus. 400 se sconosciuto. |
| `GET api/rail.php?stop=STOPID` | `{"source":"astral"\|"gtfs"\|"none","directions":[{"destination","route":"RL_PSP-CC"\|null,"entries":[Entry…]}]}` — port di `PoleDetailViewModel.refreshRailDepartures`: per ogni `trainRoutes` candidato prova `AstralRepository::departures`; tiene quelli risolti; se nessuno → fallback GTFS statico (`GTFSStore.scheduledDepartures`, raggruppato per destinazione, `delayMinutes:null`), `route:null`. Entries = **giornata intera**, ordinate per `sortSeconds` (il client filtra "upcoming"). `directions` ordinate per `destination`. Cache max 15 s sul lato ASTRAL (via `AstralRepository`). |

## Endpoint live (nessun DB, salvo dove indicato)

| Endpoint | Risposta |
|---|---|
| `GET api/cotral-transits.php?pole=CODE` | `{"pole":{"code","name","stopName","locality","comune","lat","lon"}\|null,"transits":[Transit…]}`; senza dati (`</transiti>` o nessuna corsa) → `{"pole":null,"transits":[]}`. Lat/lon con la normalizzazione `normalizeLatLon` di iOS. Cache 8 s. |
| `GET api/cotral-vehicle.php?code=VEHICLECODE` | `{"lat":41.9,"lon":12.5}` oppure `{"lat":null,"lon":null}` (ultimo punto valido ≠ (0,0) della prima `posizione`). Cache 5 s. |
| `GET api/cotral-vehicles.php?poles=a,b,c` | Scansione "opportunistica" lato server (max 15 pole, port di `CotralViewportVehicleService.scan`): transits per ogni pole (cache) → filtra `canTrackVehicle` (monitorata=="1" && vehicleCode) → posizione per veicolo. `{"vehicles":[{"id":"cotral-CODE","code","lat","lon","routeId":percorso\|null,"routeLabel":percorso\|null,"kind":"bus"\|"treno","delaySeconds":int\|null,"tripId":idCorsa\|null}]}`. `kind:"treno"` se `percorso` è un codice `CotralTrainRoute`. `delaySeconds` solo se `isDelayReliable` (monitorata=="1" e vehicleAlive). |
| `GET api/astral-line.php?route=RL_PSP-CC` | `{"route","directionLabel","lineName","stations":[{"name","code","order","next":Entry\|null}]}` — per ogni stazione ASTRAL il primo passaggio **non ancora passato** (sortSeconds ≥ adesso Roma) via `/api/transit` in parallelo (curl_multi). Cache 20 s. |
| `GET api/atac-vehicles.php` | `{"updated":ts,"vehicles":[{"id":"atac-VID","lat","lon","bearing":num\|null,"routeId":str\|null,"routeLabel":str\|null,"kind","operator","tripId":str\|null,"headsign":str\|null}]}` — decodifica protobuf `vehicle_positions`; routeLabel = short_name della route (fallback routeId), kind/operator dalla tabella `atac_routes` (fallback bus/Atac), headsign = `atac_trips.headsign` del suo `tripId` (una sola query batch; `null` se DB mancante o corsa non trovata). Cache 12 s. |
| `GET api/atac-live.php?stops=ID1,ID2` | `{"updated":ts,"stops":{"ID1":[{"tripId","routeId","routeLabel","kind","ts","delaySeconds":int\|null,"headsign":str\|null,"cancelled":bool}]}}` — da `trip_updates`: arrivo (o partenza) con `time>0` e `ts > adesso-120`, ordinati per ts. Max 150 stop. headsign da `atac_trips`. |
| `GET api/atac-trip.php?trip=TRIPID` (i trip id Atac contengono `#`, es. `0#1640-11`: il client deve fare `encodeURIComponent`) | `{"tripId","routeId","routeLabel","headsign","stops":[{"stopId","stopName","sequence","ts","delaySeconds":int\|null}]}` — tutte le fermate della corsa (passate e future) ordinate per sequence; `stops:[]` se la corsa non è nel feed. |

Nota ASTRAL/TLS: `gestionecorse.astralspa.it` serve la catena TLS **incompleta** (manca l'intermedio Sectigo): browser e iOS lo recuperano via AIA, OpenSSL/cURL di PHP no
(`SSL certificate verify result: unable to get local issuer certificate`). Fix opzionale: salvare il PEM dell'intermedio in `data/astral-ca.pem` (o puntarlo con `astral_ca_file` / `MADOVAI_ASTRAL_CA_FILE`):
viene usato come CA file solo per le richieste ASTRAL. `astral_base_url` / `MADOVAI_ASTRAL_BASE_URL` permette di puntare a un proxy/stub (test).

`Transit` (cotral-transits): 
```jsonc
{"idCorsa":"11563486","percorso":"CF952A","partenzaCorsa":"…","orarioPartenzaCorsa":"HH:MM","arrivoCorsa":"VELLETRI | Stazione FS (f2818)",
 "orarioArrivoCorsa":"HH:MM","soppressa":"Y"|"N","numeroOrdine":"17","tempoTransito":"HH:MM","ritardoSeconds":0,"passato":"…",
 "vehicleCode":"T393"|null,"vehicleAlive":true,"testoFermata":"…","instradamento":"…","banchina":"…","monitorata":"1"|"0","accessibile":"…"}
```
Conversione secondi→"HH:MM" con wrap a 24h per gli orari (non per il ritardo), come `CotralTimeUtils.readableTime`.

## Promemoria e Web Push

Sul web non esiste `BGAppRefreshTask`: l'equivalente è **Web Push + cron sul server** (iOS ≥ 16.4 solo con la PWA aggiunta alla Home).

| Endpoint | Descrizione |
|---|---|
| `GET api/push-key.php` | `{"publicKey":"<base64url, 65 byte P-256 non compresso>"}`; 503 se il push non è configurato (`php bin/gen-vapid.php`). |
| `POST api/reminders.php` | Body `{"subscription":{"endpoint","keys":{"p256dh","auth"}},"reminders":[Reminder…]}` → **sostituisce** tutti i promemoria di quella sottoscrizione (il client è la fonte di verità). `{"ok":true,"count":n}`. Con `?action=unsubscribe` (body `{"subscription":{"endpoint"}}`) cancella sottoscrizione e promemoria. Validazione rigida (endpoint https su porta 443 e host DNS pubblico (no IP/localhost), ≤ 600 caratteri, `p256dh` = 65 byte su curva P-256, `auth` = 16 byte, id `[A-Za-z0-9-]{1,64}` univoci, stopName ≤ 120, hour 0–23, minute 0–59, weekdays ⊂ 1..7 (deduplicati), max 30 promemoria, source valido); altrimenti 400. 503 se il server ha già 5000 sottoscrizioni. Un promemoria con id e orario/giorni/sorgente invariati **conserva** lo stato (già eseguito oggi / tentativi); uno nuovo o modificato riparte da zero e, se l'orario di oggi è già trascorso, non scatta retroattivamente. |
| `POST api/push-test.php` | Body `{"subscription":{…}}` → invia subito (sincrono) una notifica di prova "Notifiche attive". Risposta 200 `{"ok":true,"status":201}`; se il push service rifiuta `{"ok":false,"status":N,"error":"…"}`; se la sottoscrizione è scaduta (404/410) `{"ok":false,"gone":true,…}` e viene cancellata (il client deve ri-sottoscriversi). 429 `{"error","retryAfter"}` + header `Retry-After` se < 30 s dal test precedente della stessa sottoscrizione. |
| `php bin/remind.php` | Da cron **ogni minuto** (`* * * * * php /percorso/Madovai-Web/bin/remind.php >> /percorso/Madovai-Web/data/remind.log 2>&1`). Esegue i promemoria dovuti (lock esclusivo `data/remind.lock`). Opzioni: `--now="YYYY-MM-DD HH:MM"` (orologio finto, ora di Roma), `--dry-run` (stampa senza inviare né scrivere stato), `--verbose`. `vapid_subject` (config.php / `MADOVAI_VAPID_SUBJECT`, default `mailto:admin@example.com`) identifica il server verso i push service: impostarlo. |
| `php bin/gen-vapid.php` | Genera `data/vapid.json` (chiavi P-256) una volta sola. |

`Reminder` (client ↔ server; weekdays come `Calendar` Apple: **1 = domenica … 7 = sabato**):
```jsonc
{"id":"uuid","stopName":"Acilia","weekdays":[2,3,4],"hour":7,"minute":30,
 "source":{"type":"cotralBus","poleCode":"1021"}
        | {"type":"cotralTrain","stationName":"Acilia","route":"RL_PSP-CC"}
        | {"type":"atacStop","stopId":"05000"}}
```
Comportamento (identico a iOS, vedi `ReminderScheduler.swift`/`ReminderNotifier.swift`/`ReminderDepartureStatus.swift`):
al minuto previsto (giorno della settimana + HH:MM, ora di Roma) recupera il prossimo passaggio e manda **subito** una push;
se il recupero fallisce (rete, nessun dato) **nessuna notifica**, ritenta dopo 2 minuti, max 15 tentativi, poi rinuncia fino al
prossimo giorno previsto. Una sola esecuzione per promemoria per giorno (stato in `state.sqlite`). Finestra di tolleranza se il cron salta un minuto.
Testi (`title`/`body`) come `ReminderNotifier`. Payload push: `{"title","body","tag":reminderId,"url":"./#/promemoria"}`.

## Schema `data/madovai.sqlite` (scritto da `bin/build-data.php`, letto dagli endpoint)

Tabelle (nomi/colonne **vincolanti**; indici a discrezione di chi le scrive):
```
meta(key TEXT PK, value TEXT)                       -- built_at, versioni sorgenti
cotral_stops(stop_id PK, name, name_lc, locality, lat REAL, lon REAL, is_rail INT)   -- bus + rail uniti, name già senza " # code"; indice (lat,lon)
cotral_routes(route_id PK, short_name, long_name, is_rail INT, short_lc, long_lc)     -- rail con prefisso "F:"; long_name già senza " # code"; *_lc = minuscolo (ricerca)
cotral_stop_routes(stop_id, route_id, PRIMARY KEY(stop_id,route_id))                  -- indice su route_id
cotral_rail_shapes(route_id, shape_id, polyline, min_lat, min_lon, max_lat, max_lon)
rail_trips(trip_id PK, route_id, service_id)                                           -- route_id con "F:"
rail_stop_times(trip_id, seq INT, stop_id, dep_secs INT, PRIMARY KEY(trip_id,seq))
rail_calendar(service_id PK, mon,tue,wed,thu,fri,sat,sun INT, start_date INT, end_date INT)
rail_calendar_dates(service_id, date INT, added INT)                                   -- added: 1/0
atac_stops(stop_id PK, name, name_lc, lat REAL, lon REAL)                              -- indice (lat,lon), indice name
atac_routes(route_id PK, short_name, long_name, kind INT, operator TEXT, color TEXT NULL, short_lc, long_lc)  -- *_lc = minuscolo (ricerca)
atac_shapes(route_id, shape_id, polyline, min_lat, min_lon, max_lat, max_lon)
atac_trips(trip_id PK, route_id, service_id, headsign TEXT NULL)                       -- headsign già pulito (vedi cleanHeadsign)
atac_stop_routes(stop_id, route_id, PRIMARY KEY(stop_id,route_id))                     -- indice su route_id
atac_stop_headsign(route_id, stop_id, headsign, PRIMARY KEY(route_id,stop_id))
atac_service_dates(date INT, service_id)                                               -- da calendar_dates.txt (exception_type 1)
atac_stop_times(stop_id, dep_secs INT, trip_rid INT, PRIMARY KEY(stop_id,dep_secs,trip_rid)) WITHOUT ROWID
                                                                                       -- schedule completo (5M righe, compatto: trip_rid = rowid di atac_trips, NON il trip_id testuale;
                                                                                       --   join: atac_trips t ON t.rowid = x.trip_rid)
```
Il builder scarica i 3 zip (`Config::*_URL`), costruisce in un file temporaneo e fa `rename` atomico; supporta `--from-dir=DIR`
(cartella con sottocartelle `bus/ rail/ atac/` già estratte) per i test, e non deve superare ~512 MB di RAM
(lettura a stream di `stop_times.txt`, 3.7M + 5.0M righe).
Gli zip vengono letti **in streaming** (ZipArchive::getStream, o `unzip -p` se manca l'estensione zip): niente estrazione su disco.
Opzioni extra: `--from-zips=DIR` (cotral_bus.zip, cotral_rail.zip, atac.zip già scaricati), `--data-dir=DIR`, `--quiet`. Serve ~250 MB di disco libero durante la build.

## Interfacce PHP tra moduli

```php
// src/Live  (modulo B)
Madovai\Live\CotralClient::transits(string $poleCode): ?array            // come api/cotral-transits.php, null se nessun dato
Madovai\Live\CotralClient::vehiclePosition(string $vehicleCode): ?array  // ['lat'=>float,'lon'=>float] | null
Madovai\Live\AstralRepository::stations(string $route): array            // [['name','code','order'],…] ordinate
Madovai\Live\AstralRepository::departures(string $route, string $stationName): ?array // ['destination','route','entries'=>[Entry…]] | null (stazione non risolta)
Madovai\Live\AtacRealtime::vehicles(): array                              // come api/atac-vehicles.php
Madovai\Live\AtacRealtime::stopArrivals(array $stopIds): array            // come api/atac-live.php
Madovai\Live\AtacRealtime::trip(string $tripId): ?array
Madovai\Live\AtacRealtime::upcomingArrivals(string $stopId, int $limit = 2): array // [['ts','delaySeconds','isCancelled'],…] per i promemoria
Madovai\Live\DepartureStatus::forReminder(array $reminder): ?array        // ['time'=>'HH:MM','delayMinutes'=>?int,'isCancelled'=>bool,'nextUsefulTime'=>?string] | null (= fallimento)
```

## Test
Dati reali di prova già scaricati/estratti in
`/private/tmp/claude-501/-Users-gabriele-Downloads/32124076-7e88-4f5d-a029-ade14789ae64/scratchpad/gtfs/{bus,rail,atac}/`.
Server locale: `php -S 127.0.0.1:8099 -t public public/router.php` (router.php gestisce `/api/x` → `api/x.php` se serve) con
`MADOVAI_DATA_DIR=<dir temporanea>` per non sporcare `data/`. Usare i feed live veri per verificare (Cotral, ASTRAL, Roma Mobilità sono raggiungibili).
