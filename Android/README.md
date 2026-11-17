# Madovai per Android

Client Android nativo (Kotlin + Jetpack Compose, Material 3 / Material You, Android 8.0+) per bus/treni Cotral (extraurbano Lazio) **e** bus/tram/metro Atac + Roma TPL (urbano Roma), su un'unica mappa. Nome dell'app: **Madovai** ("ma dove vai?"), package / application id `dev.gab8bit.madovai` — lo stesso bundle id dell'app iOS.

Dalla **2.0** l'app è un client leggero del [backend Madovai](../Backend) (`https://madovai.gab8bit.net/api/v1`), lo stesso usato dalla [web app](../Web) e dall'app [iOS](../iOS) 2.x: non scarica più i GTFS sul telefono, non decodifica protobuf, non parla più direttamente con Cotral né con ASTRAL. Funzioni allineate alla web app (riferimento: `Web/public/js/`), aspetto Android (Material 3).

Pagina di presentazione e download: **https://gab8bit.github.io/Madovai/android/** · APK nelle [Release](https://github.com/Gab8bit/Madovai/releases?q=android&expanded=true) (tag `android-v…`). Fa parte del progetto [Madovai](../README.md).

## Come funziona

### Dati: solo il backend
Tutto passa da un unico client HTTPS (`api/ApiClient.kt` + `api/MadovaiApi.kt`, OkHttp; JSON letto a mano con `org.json`, che fa parte di Android: niente reflection, niente regole R8 per i modelli). L'indirizzo è in un solo punto, [`Config.kt`](app/src/main/java/dev/gab8bit/madovai/Config.kt) (`API_BASE_URL`, `HEALTH_URL`), insieme a tutti gli intervalli e le soglie, valore per valore uguali a `Config.swift` di iOS 2.0.

| Endpoint | Usato per |
|---|---|
| `stops`, `shapes` | paline Cotral, fermate Atac e percorsi del riquadro visibile — solo da zoom 13 in su |
| `search` | ricerca unica di fermate e linee (mappa e modulo dei promemoria) |
| `lines`, `line` | scheda Linee, dettaglio linea (fermate in ordine di percorso, come le dà il backend), linea isolata sulla mappa |
| `atac-stop`, `atac-live`, `atac-schedule` | scheda di una fermata Atac: banchine con direzione, arrivi in tempo reale, orari stimati se non c'è tempo reale |
| `atac-vehicles`, `atac-trip` | flotta Atac/Roma TPL (ogni 15 s), orario completo della corsa di un mezzo |
| `cotral-transits`, `pole`, `rail` | scheda di una palina Cotral (transiti PIV.do), direzioni ASTRAL di una stazione, orari dei treni (ASTRAL, altrimenti tabella) |
| `cotral-vehicles`, `cotral-vehicle` | mezzi Cotral vicino alle paline visibili (max 15 paline, ogni 18 s), mezzo seguito con "Segui" (ogni 12 s) |
| `astral-line` | scheda di un treno Cotral: prossimo passaggio a ogni stazione della linea |
| `/health` | banner "Server non raggiungibile" / "Dati non ancora disponibili" |

Gli errori del backend (`{"error": "…"}`, già in italiano) vengono mostrati così come sono; quelli di rete hanno testi italiani propri (`ApiException`). Il polling gira **solo con l'app in primo piano** (`live/Poller.kt`); un aggiornamento richiesto mentre ne è in corso un altro viene messo in coda invece di annullarlo (lezione di iOS: annullare la prima richiesta lasciava la mappa vuota per un intervallo). `live/ConnectivityMonitor.kt` segue la rete del telefono e lo stato del server.

### Mappa
[osmdroid](https://github.com/osmdroid/osmdroid) con tile OpenStreetMap (`ui/map/OsmMap.kt`): **nessuna API key, nessun account Google, nessun Play Services**. Tile attenuate (in scuro, grigi invertiti), percorsi delle linee, fermate Atac, paline Cotral, mezzi in tempo reale con animazione di spostamento: badge con il numero di linea da zoom 14, pallini sotto, nascosti sotto zoom 11 (una linea isolata mostra sempre i suoi mezzi). Lo User-Agent delle tile segue la [policy OSM](https://operations.osmfoundation.org/policies/tiles/), la cache delle tile sta nella cache privata dell'app.

### Interfaccia
- **Barra di navigazione** Material 3 con quattro schede: **Mappa**, **Linee**, **Preferiti**, **Promemoria** (`MainActivity.kt`).
- **Mappa:** ricerca unica (linee e fermate), pulsanti posizione / linee / info, banner per offline, server non raggiungibile, dati in preparazione, caricamento lento (solo se la richiesta supera 0,4 s), "Avvicina la mappa…" sotto zoom 13. Tocca una fermata, una palina o un mezzo: si apre un **`ModalBottomSheet` M3** (`ui/sheets/`), aggiornato ogni 15 s solo mentre è visibile.
- **Linea isolata:** toccare un mezzo o scegliere una linea Atac in ricerca mostra solo quella linea (percorso, fermate, mezzi) finché non si preme "Reset"; una linea Cotral in ricerca mostra tutte le sue fermate e apre l'elenco delle stazioni.
- **Segui:** su un transito Cotral monitorato, "Segui" aggancia quel mezzo (posizione ogni 12 s) con un banner sulla mappa e nella scheda, che diventa "Tracking interrotto" se il mezzo smette di trasmettere.
- **Linee:** metro Atac + treni Cotral, bus e tram Atac/Roma TPL, con ricerca; il dettaglio mostra i mezzi della linea e il prossimo arrivo a ogni fermata. I ~4000 bus Cotral sono esclusi di proposito, come su web e iOS.
- **Preferiti:** fermate Cotral e Atac nella stessa lista (Jetpack DataStore, `service/FavoritesStore.kt`).
- **Info:** come funziona, legenda, crediti, versione (da `BuildConfig`).
- **Material You:** colori dinamici da Android 12, altrimenti un tema derivato dal blu `#1E5EA8`; i colori con significato (Cotral arancio, Atac teal, metro/tram/treno, ritardo/anticipo) sono fissi (`ui/theme/Theme.kt`).

### Promemoria (locali, senza Google)
Stesso modello della web app e del backend (`model/Reminder.kt`): fermata (`cotralBus` + codice palina, `cotralTrain` + stazione/direzione ASTRAL/id stazione, `atacStop` + stop id), ora e minuti **ora di Roma**, giorni con **1 = domenica … 7 = sabato**. Su Android si aggiunge solo un interruttore attivo/in pausa. Salvati in DataStore, con lo stesso JSON della web app.

La notifica **non** arriva dal server (FCM non è usato: l'app resta senza servizi Google). All'orario scelto:
1. `reminders/ReminderScheduler.kt` ha armato un allarme `AlarmManager` per ogni promemoria attivo: `setExactAndAllowWhileIdle` se l'app può usare le sveglie esatte (sempre fino ad Android 11; da Android 12 con l'accesso speciale "Sveglie e promemoria", che da Android 14 non è più concesso di default), altrimenti `setAndAllowWhileIdle` (può slittare di qualche minuto: la scheda Promemoria lo dice e porta all'impostazione). `USE_EXACT_ALARM` non è dichiarato (Play lo riserva a sveglie e calendari).
2. `ReminderReceiver` chiede al backend il prossimo passaggio (`ReminderStatusFetcher`: `cotral-transits`, `rail` o `atac-live`) con la stessa logica di `Backend/src/live/departureStatus.ts`, e pubblica una notifica locale con **gli stessi testi** della web app ("Prossimo bus alle 07:41", "… è in ritardo di 3 minuti.", "… è stato soppresso. Prossimo utile: 07:56.").
3. Se il controllo fallisce (rete, nessun dato) nessuna notifica: riprova dopo 2 minuti, al massimo 15 tentativi entro un'ora, poi aspetta il giorno successivo previsto — le regole del backend. Un'occorrenza persa (telefono spento) non viene recuperata in ritardo.

Gli allarmi vengono riarmati a ogni modifica, a ogni avvio dell'app, dopo il riavvio del telefono (`BOOT_COMPLETED`), cambio di ora o fuso (`TIME_SET`, `TIMEZONE_CHANGED`), aggiornamento dell'app (`MY_PACKAGE_REPLACED`) e quando viene concesso l'accesso alle sveglie esatte. Il permesso `POST_NOTIFICATIONS` (Android 13+) si chiede solo al primo salvataggio di un promemoria (o dal pulsante "Attiva"); se è stato negato definitivamente la scheda porta alle impostazioni di sistema. Limiti noti: Doze può raggruppare gli allarmi inesatti; alcuni produttori (risparmio energetico "aggressivo") bloccano gli allarmi delle app chiuse finché l'utente non esclude Madovai dall'ottimizzazione della batteria.

Tutta la logica che decide orari, tentativi, stato e testi è codice puro, coperta dai test JVM.

## Stack tecnico

Dal `app/build.gradle.kts` (AGP 8.7.3, Kotlin 2.1.0, Gradle wrapper 8.11.1, JDK 17, `compileSdk`/`targetSdk` 35, `minSdk` 26):

| Area | Libreria |
|---|---|
| UI | Jetpack Compose (BOM 2024.12.01), Material 3, material-icons-extended |
| Navigazione | navigation-compose 2.8.5 |
| Activity/lifecycle | activity-compose 1.9.3, lifecycle-runtime-compose 2.8.7, core-ktx 1.15.0 |
| Persistenza | datastore-preferences 1.1.1 (preferiti, promemoria) |
| Concorrenza | kotlinx-coroutines-android 1.9.0 |
| Rete | OkHttp 4.12.0 (JSON con `org.json` di Android) |
| Mappa | osmdroid-android 6.1.20 |
| Test | JUnit 4, `org.json` di riferimento, OkHttp MockWebServer, kotlinx-coroutines-test |

Nessun Google Play Services, nessun Firebase, nessuna libreria di analytics.

## Build (in un container, niente sul Mac)

Serve solo Docker (OrbStack o Docker Desktop): JDK, Android SDK e cache di Gradle vivono dentro un container usa-e-getta, che lo script crea, usa e cancella.

```bash
./build_apk.sh            # APK debug → dist/Madovai-debug.apk
./build_apk.sh test       # test JVM + Android Lint
./build_apk.sh release    # test + lint + APK di release firmato → dist/Madovai-v<versione>.apk
```

Cosa fa `build_apk.sh`: avvia un container `linux/amd64` da `eclipse-temurin:17-jdk-jammy` (amd64 perché l'`aapt2` per Linux che AGP scarica esiste solo x86_64; su Apple Silicon gira con Rosetta), installa al suo interno cmdline-tools, `platforms;android-35` e `build-tools;35.0.0`, monta questa cartella **in sola lettura** e la copia nel container prima di lanciare Gradle (così `build/`, `.gradle/`, `.kotlin/` e `local.properties` non finiscono mai nel repo), poi copia fuori solo l'APK e cancella il container (e l'immagine, se l'aveva scaricata lui; `KEEP_IMAGE=1` per tenerla). In modalità release verifica la firma con `apksigner verify --print-certs`.

La build di release è minificata con R8 e con le risorse inutilizzate rimosse (regole in [`app/proguard-rules.pro`](app/proguard-rules.pro): solo osmdroid, che non porta regole proprie).

> **Firma delle release.** Le release sono firmate con una keystore dedicata, conservata privatamente fuori dal repository — non quella di debug generata da Android. Android installa un aggiornamento sopra una versione esistente **solo se la firma è la stessa**, quindi tutte le versioni vanno firmate con questa chiave (la 2.0.0 si installa sopra la 1.0.0). Per la release lo script monta la cartella della keystore, in sola lettura, allo stesso percorso dentro il container: Gradle la legge da sé, nessun segreto passa dalla riga di comando. Se la cartella non c'è, l'APK di release esce senza firma; se c'è ma il container non la può leggere (cartella in iCloud non scaricata, o OrbStack/Docker senza permesso di accesso ai file di iCloud Drive) lo script si ferma e lo dice.

### Test
`./build_apk.sh test` (o `./gradlew testDebugUnitTest lintRelease` dentro il container): test JVM senza emulatore —
- decodifica di ogni endpoint su JSON **catturati dal backend di produzione** (`app/src/test/resources/fixtures/`);
- client HTTP contro un MockWebServer locale (URL e codifica dei parametri, errori 400/429/502/503 in italiano, timeout, rete assente, suddivisione di `atac-live` a 150 fermate);
- promemoria: JSON identico alla web app, prossima esecuzione in ora di Roma (anche al cambio dell'ora legale), regole dei tentativi, stato del prossimo passaggio per le tre sorgenti, testi delle notifiche, fetch contro un backend finto;
- preferiti salvati dalla 1.0.0 (stesso formato, stessi id del backend), modelli e logica della mappa.

## Dalla 1.0.0 alla 2.0.0

- **Rimosso:** download e parsing dei GTFS sul telefono (Cotral bus/treni e Atac, ~300 MB estratti), binding GTFS-Realtime/protobuf, client XML di Cotral (`PIV.do`/`Automezzi.do`), client ASTRAL, certificato intermedio Sectigo in `res/raw`, `network_security_config.xml` (eccezioni cleartext per Cotral e trust anchor per ASTRAL: ora l'app parla solo HTTPS con il backend e con le tile OSM, con le regole predefinite di Android), `android:largeHeap`, regole ProGuard per protobuf, test live `LiveFeedsSmokeTest`. Al primo avvio la 2.0 cancella le cartelle `files/GTFS` e `files/AtacGTFS` lasciate dalla 1.0.0.
- **Nuovo:** client del backend, scheda **Promemoria** (locale), banner di connessione/server, fermate e percorsi caricati per riquadro da zoom 13, mezzi a pallino/badge secondo lo zoom, banner del mezzo seguito anche sulla mappa, versione nella scheda Info, test su dati reali.
- **Preferiti:** restano. La 1.0.0 usava già come id lo `stop_id` GTFS grezzo (Cotral `codicePalina`, Atac `stopId`), che è esattamente l'id che si aspettano gli endpoint del backend; il formato salvato in DataStore è rimasto lo stesso. Nessuna migrazione necessaria (verificato dai test con i dati di produzione).

## Storia (1.0.0, dati sul telefono)

La 1.0.0 parlava direttamente con Cotral, ASTRAL e i feed GTFS/GTFS-Realtime. Alcuni problemi di allora restano utili da sapere, anche se la 2.0 non ne è più toccata:

- **ASTRAL e la catena TLS incompleta:** `gestionecorse.astralspa.it` invia solo il certificato foglia; Android non scarica l'intermedio mancante (AIA) come fanno iOS e i browser. Serviva un trust anchor dedicato. Ora è un problema del backend (vedi `Web/docs/API.md`).
- **Cotral solo in HTTP** sulla porta 7777: serviva un'eccezione cleartext. Ora è un problema del backend.
- **Rete sul main thread:** leggere il body di una risposta OkHttp è I/O di rete; va fatto su `Dispatchers.IO` (come fa ancora `ApiClient`).
- **Regex:** il motore regex di Android (ICU) rifiuta il flag inline `(?U)` che sulla JVM dei test funziona: evitare i flag "esotici".
- **Coordinate Cotral invertite** in `PIV.do`: ora le normalizza il backend.

## Crediti dati
- Fermate e linee: feed GTFS pubblici di Cotral e di Roma Servizi per la Mobilità (CC-BY 3.0 Italia) per Atac/Roma TPL.
- Tempo reale: endpoint pubblici di Cotral, API orari di ASTRAL, feed GTFS-Realtime di Roma Servizi per la Mobilità — raccolti e messi in cache dal backend Madovai.
- Mappa: © OpenStreetMap contributors (ODbL), via osmdroid.

Progetto indipendente, non affiliato con Cotral, ASTRAL o Roma Capitale/Atac.
