# Madovai Backend

Backend di **Madovai** — bus, tram, metro e treni di Roma e del Lazio in tempo reale (Cotral, ASTRAL, Atac/Roma TPL).
Node.js 24 + TypeScript + Fastify, in un container Docker. Serve tre tipi di client con la stessa API:

- la **PWA Madovai Web** (ospitata altrove: questo container è solo API, ma risponde anche agli indirizzi `/api/*.php` che la PWA usa già);
- un'app **Android** (notifiche dei promemoria via Firebase Cloud Messaging);
- un'app **iOS** (notifiche via APNs: il supporto è pronto ma spento, perché richiede l'Apple Developer Program a pagamento).

È la riscrittura del backend PHP di Madovai Web, con le stesse funzioni e le stesse risposte JSON.

## Cosa fa

| Area | Cosa |
|---|---|
| Dati statici | Scarica i feed GTFS di Cotral (bus e treni) e di Roma Mobilità e li elabora in SQLite: fermate, linee, percorsi, orari programmati. Al primo avvio e poi ogni notte. |
| Dati live | Passaggi Cotral (PIV.do), orari e ritardi dei treni (ASTRAL), veicoli e arrivi Atac/Roma TPL (GTFS-Realtime). Con cache condivisa: N utenti = 1 richiesta verso le fonti. |
| Promemoria | Ogni minuto controlla i promemoria in scadenza, recupera il prossimo passaggio e manda la notifica al dispositivo (Web Push, FCM, APNs). |
| Documentazione | OpenAPI 3.1 navigabile su `/docs`. Contratto e scelte in `docs/API.md`. |

## Avvio con Docker (OrbStack sul Mac)

Il compose "di lavoro" sta in `~/docker/madovai-backend` (come gli altri servizi):

```bash
cd ~/docker/madovai-backend
docker compose up -d --build
```

- `docker compose up -d --build`: costruisce l'immagine dal sorgente (la cartella `Backend/` del repo Madovai) e avvia il container in background.
- Al primo avvio scarica ed elabora i dati GTFS (circa 20-30 secondi): nel frattempo gli endpoint statici rispondono 503, quelli live funzionano già.
- API: <http://localhost:8083/api/v1/…> · documentazione: <http://localhost:8083/docs> · stato: <http://localhost:8083/health>
- I dati (database, chiavi delle notifiche, promemoria) restano in `~/docker/madovai-backend/data`.

Comandi utili:

```bash
docker compose logs -f                 # log in tempo reale
docker compose restart                 # riavvio
docker compose down                    # ferma e rimuove il container (i dati in ./data restano)
docker compose up -d --build           # dopo aver modificato il codice: ricostruisce e riavvia
docker compose exec madovai-backend node dist/cli/build-data.js   # ricostruisce subito i dati GTFS
```

In alternativa, dalla cartella del progetto: `docker compose up -d --build` (usa un volume Docker invece di `./data`).

## Produzione (VM Docker)

Il deploy sulla VM si fa dal Mac con un comando: `DEPLOY_HOST=utente@IP-VM scripts/deploy.sh` (costruisce l'immagine per amd64,
la trasferisce via SSH e riavvia il container). Preparazione della VM, configurazione, aggiornamenti, backup e disinstallazione:
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Configurazione

Tutto tramite variabili d'ambiente (nel `docker-compose.yml` o in un file `.env`): vedi `.env.example`, commentato riga per riga.

### Notifiche Android (FCM)

1. Crea un progetto su <https://console.firebase.google.com> e aggiungi l'app Android.
2. Impostazioni progetto → **Account di servizio** → **Genera nuova chiave privata**: scarica il file JSON.
3. Copialo in `~/docker/madovai-backend/secrets/firebase-service-account.json`.
4. Nel `docker-compose.yml` togli il `#` da `FCM_SERVICE_ACCOUNT_FILE`, poi `docker compose up -d`.
5. Verifica: `curl http://localhost:8083/api/v1/push/config` deve mostrare `"fcm":{"enabled":true}`.

### Notifiche iOS (APNs) — richiede l'Apple Developer Program

1. Su developer.apple.com → Certificates, IDs & Profiles → **Keys** → crea una chiave con "Apple Push Notifications service": scarica il file `.p8`.
2. Copialo in `~/docker/madovai-backend/secrets/` e imposta `APNS_KEY_FILE`, `APNS_KEY_ID` (id della chiave), `APNS_TEAM_ID`, `APNS_TOPIC` (bundle id, es. `dev.gab8bit.madovai`).
3. `APNS_PRODUCTION=true` per le app distribuite (TestFlight/App Store); lasciato `false` per le build di sviluppo.

## Passare dal backend PHP a questo

Il backend legge e migra i dati del PHP: copia `state.sqlite` e `vapid.json` dalla cartella dati del server
(`/var/www/madovai-data`) in `~/docker/madovai-backend/data/` prima del primo avvio. Promemoria e notifiche già attivate
sui telefoni continuano a funzionare, perché la chiave VAPID resta la stessa. La PWA chiama gli stessi indirizzi
(`/api/*.php`): basta servirla da un'origine che inoltri `/api/` a questo backend (o puntarla al suo indirizzo).

## Sviluppo senza Docker

```bash
npm install
npm run dev            # http://localhost:3000, ricarica a ogni modifica (dati in ./data)
npm test               # test (vitest)
npm run typecheck      # controllo dei tipi
npm run build && npm start
```

## Struttura

```
src/
  app.ts, server.ts     app Fastify (CORS, rate limit, OpenAPI, errori) e avvio + job in background
  config.ts             configurazione (env) e URL delle fonti
  gtfs/                 build dei dati statici (worker thread) e query
  live/                 client Cotral, ASTRAL, GTFS-Realtime Atac, stato del prossimo passaggio
  push/                 dispositivi, promemoria, scheduler, canali Web Push / FCM / APNs
  routes/               endpoint (v1 + alias legacy .php per la PWA)
scripts/                entrypoint del container, deploy sulla VM Docker
certs/                  certificato intermedio Sectigo per ASTRAL (catena TLS incompleta lato loro)
docs/API.md             contratto dell'API
docs/GUIDA-AGENTI-AI.md guida all'uso dell'API da dare a un agente AI
```

## Crediti

Dati trasporto Roma: Roma Servizi per la Mobilità (CC-BY 3.0 Italia). Dati Cotral: endpoint e feed GTFS pubblici di Cotral S.p.A.
Orari treni: ASTRAL S.p.A.
