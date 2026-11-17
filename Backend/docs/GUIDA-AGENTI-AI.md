# Madovai API: guida per agenti AI

Questa guida spiega a un agente AI come usare le API del backend Madovai per rispondere a domande sul trasporto pubblico
di Roma e del Lazio: fermate, linee, prossimi passaggi in tempo reale, posizione dei mezzi, orari dei treni regionali.

## In breve

- **Base URL**: `BASE_URL` (per esempio `http://IP-SERVER:8083`). Tutti gli endpoint sono sotto `BASE_URL/api/v1/`.
- **Nessuna autenticazione.** Solo HTTP + JSON.
- **Specifica OpenAPI 3.1 leggibile da macchina**: `GET BASE_URL/docs/json` (versione navigabile: `BASE_URL/docs`).
  Se un dettaglio di questa guida è in dubbio, la specifica è la fonte autorevole.
- **Stato del server**: `GET BASE_URL/health` → `{"ok":true,"version":"1.0.0","gtfsReady":true}`.
  Se `gtfsReady` è `false` il server sta ancora costruendo i dati statici (meno di un minuto dopo l'avvio): riprova più tardi.
- **Solo lettura**, tranne i tre endpoint dei promemoria (sezione 7), che modificano dati: usali solo se l'utente lo chiede esplicitamente.

## 1. Le due reti

| Rete | Cosa copre | ID | Endpoint |
|---|---|---|---|
| **Cotral** | autobus regionali del Lazio + ferrovie regionali (Roma-Lido "Metromare", Roma-Viterbo) | fermata = `id` GTFS, per esempio `f14638` (bus) o `RL_ACILIA` (stazione); linea treno = `F:…` | `pole`, `cotral-transits`, `cotral-vehicle(s)`, `rail`, `astral-line` |
| **Atac / Roma TPL** | autobus, tram e metro urbani di Roma | `id` GTFS grezzi, per esempio fermata `80725`, linea `211`, metro `MEA` | `atac-stop`, `atac-live`, `atac-schedule`, `atac-vehicles`, `atac-trip` |

Ogni fermata o linea restituita dalla ricerca ha il campo `source` (`"cotral"` o `"atac"`): decide quale famiglia di endpoint usare.
Le fermate Cotral hanno anche `rail` (`true` per le stazioni ferroviarie).

## 2. Ricette per le domande tipiche

**Primo passo quasi sempre: trovare l'ID con la ricerca.**
`GET /api/v1/search?q=termini` → `{"stops":[Stop…],"routes":[Route…]}`.
La ricerca è per parole: ignora maiuscole, accenti e punteggiatura, e trova i nomi che contengono **tutte** le parole, in
qualsiasi ordine ("roma termini", "anagnina metro", "Metro A", "211"). I risultati migliori vengono per primi:
1. nome identico;
2. nome che inizia con la ricerca;
3. tutte le parole all'inizio di una parola del nome;
4. il resto.

Le linee si trovano anche per nome completo ("Metro A", "Metro B1").
Il nome delle fermate Atac è tutto maiuscolo e spesso nella forma `VIA/INCROCIO`, quello Cotral è `LOCALITÀ | Nome`.

### "Quando passa il prossimo mezzo alla fermata X?"

1. `search?q=X` e scegli la fermata giusta.
2. Secondo il tipo:
   - **Atac** (`source:"atac"`):
     1. `atac-stop?id=ID` restituisce tutte le banchine con lo stesso nome (per esempio le varie banchine di Termini). Raccogli i loro `id`.
     2. `atac-live?stops=ID1,ID2,…` dà gli arrivi in tempo reale (`ts` = orario unix, `delaySeconds` = ritardo, `cancelled`).
     3. Se `atac-live` è vuoto o fallisce, usa `atac-schedule?stop=ID`: sono gli **orari programmati**, non tempo reale. Dillo all'utente.
   - **Cotral bus** (`source:"cotral"`, `rail:false`): `cotral-transits?pole=ID`. Ogni elemento di `transits` è una corsa:
     - `percorso` = codice linea;
     - `arrivoCorsa` = destinazione;
     - `tempoTransito` = orario previsto alla fermata ("HH:MM");
     - `ritardoSeconds` = ritardo;
     - `soppressa:"Y"` = corsa soppressa.
   - **Cotral treno** (`rail:true`): `rail?stop=ID`. Contiene una `direction` per destinazione, ciascuna con `entries` (orari della **giornata intera**):
     filtra tu quelli con `sortSeconds` ≥ ora corrente (secondi dalla mezzanotte, ora di Roma).
     - `source:"astral"` = dati in tempo reale con ritardi;
     - `"gtfs"` = solo orario programmato;
     - `"none"` = nessun dato.

### "Dov'è adesso il mezzo / il bus della linea N?"
- **Atac**: `atac-vehicles` restituisce tutti i mezzi in servizio (molti). Filtra per `routeId` o `routeLabel`. Ogni mezzo ha `lat`, `lon`, `headsign` (direzione) e `tripId`.
- **Cotral**:
  - dai transiti di una fermata prendi `vehicleCode` (solo se `monitorata:"1"`), poi `cotral-vehicle?code=CODICE` → `{"lat","lon"}`;
  - in alternativa, `cotral-vehicles?poles=ID1,ID2` (max 15 fermate) trova i mezzi tracciabili che passano da quelle fermate.

### "Che fermate fa la corsa / quando arriva al capolinea?"
`atac-trip?trip=TRIPID` restituisce tutte le fermate della corsa con orari (`ts`) e ritardi.
I trip id Atac contengono `#` (per esempio `0#2064-3`): **vanno codificati** (`0%232064-3`).

### "Com'è la situazione sulla Metromare (Roma-Lido)?"
`astral-line?route=RL_PSP-CC` (verso Cristoforo Colombo) oppure `route=RL_CC-PSP` (verso Porta San Paolo).
Per ogni stazione restituisce il prossimo treno (`next`, oppure `null` se non ce ne sono). I codici di linea di una stazione sono nel campo `trainRoutes` di `pole?id=ID`.

### "Che fermate ci sono qui vicino?"
`stops?minLat=…&minLon=…&maxLat=…&maxLon=…` restituisce le fermate dentro il rettangolo, ordinate per vicinanza al centro.
Per "vicino a un punto" usa un rettangolo di circa ±0.003° (≈ 300 m). Limiti facoltativi: `cotralLimit` (default 150), `atacLimit` (default 400).

### "Che percorso fa la linea N?"
`line?source=atac|cotral&id=ID` restituisce la `route`, le `stops` e le `shapes`:
- `coords` di una shape è una *Google Encoded Polyline* con precisione 5;
- le fermate sono **in ordine di percorso**:
  - Atac e bus Cotral: prima la direzione 0 dal capolinea, poi la direzione 1. Le fermate di diramazioni e varianti
    stanno accanto alla fermata più vicina del percorso;
  - treni Cotral (`F:…`): ordine di linea.
- Atac e bus Cotral hanno anche `directions`: per ogni direzione, la destinazione (`headsign`, solo Atac) e gli id delle
  fermate in sequenza (`stopIds`). È il modo più semplice per rispondere a "che fermate fa la linea N verso X".
  Atac usa banchine diverse per le due direzioni, quindi in `stops` lo stesso nome compare due volte;
- per i bus Cotral non ci sono shape.

L'elenco di tutte le linee Atac e dei treni Cotral è in `lines`.

## 3. Regole generali

- **Orari**:
  - `"HH:MM"` è sempre ora di Roma;
  - `ts` e `updated` sono secondi unix (UTC);
  - `sortSeconds` sono secondi dalla mezzanotte di Roma.
- **Ritardi**:
  - Atac: `delaySeconds`;
  - Cotral bus: `ritardoSeconds`;
  - treni: `delayMinutes`.

  `null` = ritardo non noto. Non va confuso con zero.
- **Elenchi vuoti sono normali**: di notte o a fine servizio non ci sono corse né mezzi. Gli endpoint live non inventano mai dati.
- **Errori**: corpo sempre `{"error":"messaggio in italiano"}`.

  | Codice | Significato |
  |---|---|
  | 400 | parametro mancante o non valido, oppure linea o fermata inesistente |
  | 404 | percorso inesistente |
  | 429 | troppe richieste |
  | 502 | la fonte esterna (Cotral, ASTRAL, Roma Mobilità) non risponde: riprova fra qualche secondo |
  | 503 | dati statici non ancora pronti, oppure canale push non configurato |
- **Limite di richieste**: 300 al minuto per IP sulle `/api/`. Gli header `x-ratelimit-remaining` e `x-ratelimit-reset` dicono quanto manca.
- **Cache**: ogni risposta ha `Cache-Control: max-age`. È inutile richiedere lo stesso URL più spesso: i dati live si aggiornano ogni 3-10 s, quelli statici ogni 30 s - 1 h.
- **Encoding**: codifica sempre i parametri (`encodeURIComponent`). Gli elenchi di ID si separano con virgole.
- **`kind`**: `"bus" | "tram" | "metro" | "treno"`. **`operator`**: `"Atac" | "Roma TPL" | "Cotral"`.

## 4. Elenco degli endpoint

Tutti `GET`, prefisso `/api/v1/`. Parametri con `*` obbligatori. Tra parentesi la durata della cache.

### Statici
| Endpoint | Parametri | Risposta |
|---|---|---|
| `search` (60 s) | `q` | `{"stops":[Stop],"routes":[Route]}`: fermate max 15 Cotral + 15 Atac, linee max 10 Cotral + 10 Atac, migliori corrispondenze per prime |
| `stops` (30 s) | `minLat*` `minLon*` `maxLat*` `maxLon*` `cotralLimit` `atacLimit` | `{"cotral":[{id,name,locality,lat,lon,rail}],"atac":[{id,name,lat,lon}]}` |
| `lines` (1 h) | — | `{"atac":[Route],"cotralRail":[Route]}` |
| `line` (1 h) | `source*` (`atac`/`cotral`) `id*` | `{"route":Route,"stops":[{id,name,lat,lon,headsign}],"shapes":[{id,coords,bbox}],"directions":[{directionId,headsign,stopIds}]}`: fermate in ordine di percorso; `directions` assente per i treni |
| `shapes` (5 min) | `minLat*` `minLon*` `maxLat*` `maxLon*` `limit` (150) | `{"shapes":[{id,routeId,kind,color,coords,bbox}]}`: percorsi Atac che attraversano il rettangolo |
| `atac-stop` (1 h) | `id*` `route` | `{"name","stops":[{id,name,lat,lon,headsign}]}`: tutte le banchine con lo stesso nome |
| `atac-schedule` (30 s) | `stop*` | `[{tripId,routeId,routeLabel,kind,ts,headsign}]`: max 6 partenze **programmate** da adesso |
| `pole` (1 h) | `id*` | `{id,name,locality,lat,lon,rail,trainRoutes:[…]}`: fermata Cotral; `trainRoutes` vuoto per i bus |
| `rail` | `stop*` | `{"source":"astral"\|"gtfs"\|"none","directions":[{destination,route,entries:[Entry]}]}` |

### In tempo reale
| Endpoint | Parametri | Risposta |
|---|---|---|
| `cotral-transits` (5 s) | `pole*` | `{"pole":{code,name,stopName,locality,comune,lat,lon}\|null,"transits":[Transit]}` |
| `cotral-vehicle` (3 s) | `code*` | `{"lat","lon"}` (entrambi `null` se la posizione non è nota) |
| `cotral-vehicles` (3 s) | `poles` (max 15) | `{"vehicles":[{id,code,lat,lon,routeId,routeLabel,kind,delaySeconds,tripId}]}` |
| `astral-line` (10 s) | `route*` (`RL_PSP-CC`, `RL_CC-PSP`, …) | `{route,directionLabel,lineName,"stations":[{name,code,order,next:Entry\|null}]}` |
| `atac-vehicles` (5 s) | — | `{"updated":ts,"vehicles":[{id,lat,lon,bearing,routeId,routeLabel,kind,operator,tripId,headsign}]}` |
| `atac-live` (5 s) | `stops*` (max 150) | `{"updated":ts,"stops":{"ID":[{tripId,routeId,routeLabel,kind,ts,delaySeconds,headsign,cancelled}]}}` |
| `atac-trip` (5 s) | `trip*` | `{tripId,routeId,routeLabel,headsign,"stops":[{stopId,stopName,sequence,ts,delaySeconds}]}` (`stops:[]` se la corsa non è nel feed) |

## 5. Oggetti

```jsonc
// Route
{"source":"atac","id":"211","shortName":"211","longName":"","displayName":"211","kind":"bus","operator":"Atac","color":null,"rail":false}
// usa displayName per mostrarla. Linee treno Cotral: id "F:…".

// Stop (search)
{"source":"cotral","id":"RL_ACILIA","name":"Acilia","lat":41.78,"lon":12.36,"rail":true}
{"source":"atac","id":"80725","name":"TERMINI (MA-MB-FS)","lat":41.90,"lon":12.50,"rail":false,"metro":false}

// Entry (orario di un treno)
{"id":"RL2173","time":"05:15","sortSeconds":18900,"delayMinutes":2,"isCancelled":false,"isReplacementBus":false}

// Transit (corsa Cotral a una fermata). I campi principali:
{"idCorsa":"11563486","percorso":"CF952A","arrivoCorsa":"VELLETRI | Stazione FS (f2818)","orarioArrivoCorsa":"08:10",
 "tempoTransito":"07:42","ritardoSeconds":120,"soppressa":"N","vehicleCode":"T393","monitorata":"1"}
// tempoTransito = orario previsto a questa fermata; vehicleCode è utilizzabile solo se monitorata == "1".
```

## 6. Esempi

```bash
curl "$BASE_URL/api/v1/search?q=acilia"
curl "$BASE_URL/api/v1/rail?stop=RL_ACILIA"
curl "$BASE_URL/api/v1/atac-stop?id=80725"
curl "$BASE_URL/api/v1/atac-live?stops=05000,70240,80725"
curl "$BASE_URL/api/v1/cotral-transits?pole=f14638"
curl "$BASE_URL/api/v1/atac-trip?trip=0%232064-3"
curl "$BASE_URL/api/v1/stops?minLat=41.897&minLon=12.497&maxLat=41.903&maxLon=12.503"
```

## 7. Promemoria e notifiche (scrivono dati: solo su richiesta esplicita)

Il server invia ogni giorno, all'orario scelto, una notifica con il prossimo passaggio a una fermata.
Il **dispositivo** è il destinatario delle notifiche:

```jsonc
{"type":"webpush","subscription":{"endpoint":"https://…","keys":{"p256dh":"…","auth":"…"}}}   // browser
{"type":"fcm","token":"…"}                                                                       // Android
{"type":"apns","token":"<64 hex>","environment":"sandbox"|"production"}                          // iOS
```

| Endpoint | Body | Effetto |
|---|---|---|
| `GET push/config` | — | `{"webPush":{"publicKey"}\|null,"fcm":{"enabled"},"apns":{"enabled","topic"}}`: canali attivi sul server |
| `POST reminders` | `{"device":Device,"reminders":[Reminder]}` | **sostituisce tutti** i promemoria del dispositivo, poi risponde `{"ok":true,"count":n}`. Max 30 |
| `DELETE devices` | `{"device":Device}` | cancella dispositivo e promemoria |
| `POST push/test` | `{"device":Device}` | invia subito una notifica di prova; massimo una ogni 30 s (altrimenti 429 con `retryAfter`) |

```jsonc
// Reminder: weekdays 1 = domenica … 7 = sabato; hour/minute = ora di Roma; id [A-Za-z0-9-]{1,64}
{"id":"casa-lavoro","stopName":"Acilia","weekdays":[2,3,4,5,6],"hour":7,"minute":30,
 "source":{"type":"cotralBus","poleCode":"f14638"}
        | {"type":"cotralTrain","stationName":"Acilia","route":"RL_PSP-CC"}
        | {"type":"atacStop","stopId":"80725"}}
```

`POST reminders` è una sostituzione completa, non un'aggiunta: per aggiungere un promemoria serve inviare l'elenco intero.
Il server non espone un endpoint per leggere i promemoria salvati: la fonte di verità è il client.

## 8. Errori comuni da evitare

- Mostrare tutti gli `entries` di `rail` come "prossimi treni": coprono l'intera giornata, vanno filtrati per `sortSeconds`.
- Interrogare `atac-live` con una sola banchina: a una fermata con lo stesso nome corrispondono più banchine (una per direzione). Prima usa `atac-stop`.
- Presentare `atac-schedule` come dati in tempo reale: è l'orario programmato.
- Dimenticare di codificare il `#` nei trip id Atac.
- Trattare `delaySeconds: null` come "in orario".
- Ripetere la stessa richiesta più spesso del suo `max-age`, oppure andare oltre 300 richieste al minuto.
