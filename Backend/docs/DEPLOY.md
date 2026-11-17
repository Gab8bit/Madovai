# Deploy su una VM Docker

Il backend gira come container sulla VM dedicata a Docker. L'immagine si costruisce sul Mac e arriva sulla VM via SSH:
sulla VM non servono il codice sorgente, Node, Git o un registry. Nei comandi: `UTENTE@IP-VM` = accesso SSH alla VM.

## 1. Preparare la VM (una volta sola)

Una VM Debian 13 o Ubuntu 24.04 (x86_64), 1-2 vCPU, 2 GB di RAM per più servizi, 10+ GB di disco.

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
sudo mkdir -p /opt/madovai-backend && sudo chown $USER: /opt/madovai-backend
```

- Il primo comando usa lo script ufficiale di Docker: installa Docker Engine e il plugin `docker compose` dai repository di Docker
  (versioni più recenti di quelle della distribuzione).
- `usermod -aG docker`: permette al tuo utente di usare `docker` senza `sudo` (serve allo script di deploy, che entra via SSH).
  Esci e rientra dalla sessione perché abbia effetto.
- La terza riga crea la cartella del servizio e la rende tua. Dati e configurazione staranno lì.

Lo script di deploy usa una sola connessione SSH: senza chiave chiede la password una volta, all'inizio. Per non doverla
mai scrivere, dal Mac (una volta sola):

```bash
ssh-keygen -t ed25519
ssh-copy-id UTENTE@IP-VM
```

- `ssh-keygen` crea la tua chiave SSH (`~/.ssh/id_ed25519`), se non ce l'hai già. Se le dai una passphrase, salvala nel
  Portachiavi con `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`.
- `ssh-copy-id` copia la chiave pubblica sulla VM: da quel momento l'accesso è senza password.

## 2. Primo deploy (dal Mac)

```bash
cd ~/Git-Projects/Madovai-Backend
DEPLOY_HOST=UTENTE@IP-VM scripts/deploy.sh
```

Lo script:
1. costruisce l'immagine per **amd64** (l'architettura della VM; il Mac è ARM, quindi la compila in emulazione);
2. la comprime e la trasferisce sulla VM via SSH (~100 MB) e la carica in Docker;
3. copia `deploy/docker-compose.yml` in `/opt/madovai-backend` e, solo se non esiste già, un `.env` di esempio;
4. avvia il container e aspetta che `/health` risponda.

Al primo avvio il backend scarica ed elabora i dati GTFS (meno di un minuto): intanto gli endpoint statici rispondono 503.

## 3. Configurazione (sulla VM)

```bash
nano /opt/madovai-backend/.env
cd /opt/madovai-backend && docker compose up -d
```

- In `.env` imposta almeno `VAPID_SUBJECT=mailto:la-tua-mail` (contatto per i servizi push). Ogni voce è commentata.
- `docker compose up -d` ricrea il container con la nuova configurazione (i dati restano in `./data`).
- Notifiche Android: copia il JSON del service account Firebase in `/opt/madovai-backend/secrets/` e imposta
  `FCM_SERVICE_ACCOUNT_FILE=/secrets/firebase-service-account.json`.

Il backend risponde su `http://IP-VM:8083` (API in `/api/v1/…`, documentazione in `/docs`). Per pubblicarlo su internet,
punta il tunnel Cloudflare (o il reverse proxy) a quell'indirizzo.

## 4. Aggiornare

Dal Mac, dopo aver modificato il codice:

```bash
DEPLOY_HOST=UTENTE@IP-VM scripts/deploy.sh
```

- Stessi passaggi del primo deploy. Non tocca `.env`, `data/` e `secrets/`. Rimuove le immagini vecchie non più usate.

## 5. Comandi utili (sulla VM, in /opt/madovai-backend)

```bash
docker compose logs -f --tail 100                              # log in tempo reale
docker compose ps                                              # stato (deve essere "healthy")
docker compose restart                                         # riavvio
docker compose exec madovai-backend node dist/cli/build-data.js   # ricostruisce subito i dati GTFS
tar czf ~/madovai-backup-$(date +%F).tgz .env data secrets     # backup di configurazione, promemoria e chiavi
```

- I log ruotano da soli (3 file da 10 MB), quindi non riempiono il disco.
- Nel backup la parte importante sono `data/state.sqlite` (promemoria) e `data/vapid.json` (chiavi delle notifiche: se le perdi, gli utenti
  devono riattivare le notifiche). `data/madovai.sqlite` si ricostruisce da solo.

## 6. Disinstallare (sulla VM)

```bash
cd /opt/madovai-backend && docker compose down
docker rmi $(docker image ls -q madovai-backend)
sudo rm -rf /opt/madovai-backend
```

- `docker compose down`: ferma e rimuove il container e la sua rete.
- `docker rmi …`: elimina le immagini del backend.
- `rm -rf /opt/madovai-backend`: elimina configurazione, dati, promemoria e chiavi (irreversibile).
