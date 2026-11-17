# Madovai Web

Versione web (PWA) di **Madovai** — bus, tram, metro e treni di Roma e del Lazio in tempo reale
(Cotral, Atac, Roma TPL). Stesse funzioni e stessa interfaccia dell'app iOS, installabile dalla Home del telefono.

- **Mappa** con paline Cotral, fermate e linee Atac/Roma TPL, veicoli in movimento, ricerca di fermate e linee, "segui questo bus".
- **Linee**, **Preferiti**, **Promemoria** (notifica push sul prossimo bus/treno a giorni e orari scelti).
- Tema chiaro/scuro automatico, materiali "liquid glass" in CSS, tab bar in basso.

## Come è fatto

Da **v1.1.0** questa app è **solo frontend**: file statici (Preact + htm, Leaflet, nessuna build, nessuna CDN) che parlano con il
**backend Madovai** (progetto separato: `~/Git-Projects/Madovai-Backend`, Node.js in Docker).

```
 Browser (questa PWA, servita da Apache) ──fetch──►  https://madovai.gab8bit.net/api/v1/…  (backend)
                                                         ├─ dati statici GTFS (SQLite, ricostruiti ogni notte)
                                                         ├─ dati live Cotral / ASTRAL / Roma Mobilità (con cache condivisa)
                                                         └─ promemoria + notifiche push (Web Push, FCM, APNs)
```

```
public/        ← l'unica cartella che serve sul server: index.html, config.js, css/, js/, vendor/, icons/, sw.js
.htaccess      ← nella radice: serve tutto da public/ (per l'installazione in una sottocartella di Apache)
src/ bin/ public/api/ tests/ config.sample.php docs/API.md
               ← backend PHP originale: NON più usato, conservato come riferimento di comportamento
                 (il backend Node ne è la riscrittura e lo cita). Non va caricato sul server.
```

### Indirizzo del backend

Sta in **`public/config.js`**, una riga:

```js
window.MADOVAI_CONFIG = { apiBase: 'https://madovai.gab8bit.net/api/v1' };
```

- Dal browser serve l'indirizzo **esterno** (sopra): il browser dell'utente non può raggiungere `http://madovai-backend:3000`, che esiste solo
  dentro la rete Docker. Quell'indirizzo interno serve a chi gira *dentro* la rete (un altro container, un reverse proxy).
- Se vuoi che l'app chiami lo stesso dominio (niente CORS), metti un reverse proxy davanti e usa un percorso relativo, es. `'/madovai/api/v1'`:
  il proxy inoltra a `http://madovai-backend:3000/api/v1`.
- Il backend deve accettare l'origine dell'app (variabile `CORS_ORIGINS` del backend; di default `*`).
- Limite del backend: 300 richieste al minuto per IP. L'app resta ben sotto (sondaggi ogni 12-18 s).

## Requisiti del server (solo per la PWA)

- Apache 2.4 con `mod_rewrite`, `mod_headers`, `mod_deflate` e **HTTPS** (necessario per geolocalizzazione, installazione come app e notifiche).
- Nessun PHP, nessun database, nessun cron: sono file statici.

## Installazione e aggiornamento (ogni comando spiegato)

`UTENTE@HOST` = utente SSH e indirizzo del server; `/var/www/html/madovai` = cartella del sito (cambiala se vuoi).

### 1. Upload (dal tuo Mac, nella cartella del progetto)

```bash
rsync -avz --delete --exclude='.git' --exclude='.claude' --exclude='project-info.json' --exclude='.DS_Store' \
  --exclude='/src' --exclude='/bin' --exclude='/tests' --exclude='/data' --exclude='/docs' --exclude='/config*.php' --exclude='/public/api' --exclude='/public/router.php' \
  ./ UTENTE@HOST:/var/www/html/madovai/
```

- `rsync` copia solo ciò che è cambiato, via SSH: lo stesso comando serve per l'installazione e per ogni aggiornamento.
- `-a` conserva permessi e date, `-v` mostra i file, `-z` comprime durante il trasferimento.
- `--delete` cancella sul server i file che non esistono più in locale: le due cartelle restano identiche. I percorsi con `--exclude` sono invece
  **protetti**: rsync non li copia e non li cancella. Per questo ci sono le `--exclude`:
  - `project-info.json`: se la pagina indice del tuo server lo usa per elencare i progetti, `--delete` lo cancellerebbe. Aggiungi un'`--exclude` per
    ogni altro file che esiste solo sul server.
  - `/src /bin /tests /data /docs /config*.php /public/api /public/router.php`: il vecchio backend PHP, che non va caricato. Se erano già sul server
    **restano lì** (protetti): vedi il passo 3 del passaggio dal PHP per rimuoverli a mano.
- Se l'utente SSH non può scrivere in `/var/www/html`, prima: `ssh UTENTE@HOST 'sudo mkdir -p /var/www/html/madovai && sudo chown UTENTE: /var/www/html/madovai'`.

### 2. Apache (sul server, una volta sola)

```bash
sudo a2enmod rewrite headers deflate
sudo sed -i '/<Directory \/var\/www\/>/,/<\/Directory>/ s/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf
sudo systemctl restart apache2
```

- `a2enmod` attiva i moduli: `rewrite` esegue la regola dell'`.htaccess` che serve tutto da `public/`; `headers` imposta le intestazioni di cache;
  `deflate` comprime le risposte (importante su connessioni lente).
- Il `sed` cambia `AllowOverride None` in `AllowOverride All` nel blocco `<Directory /var/www/>`: senza, Apache **ignora tutti i file `.htaccess`**
  e l'app non funziona. Vale per tutti i progetti in `/var/www`; se non vuoi, applicalo solo a `/var/www/html/madovai` in un file in `/etc/apache2/conf-available/`.
- `restart` (non `reload`) perché hai appena attivato moduli nuovi.

Alternativa con dominio/vhost dedicato: `DocumentRoot` su `…/public` (e allora l'`.htaccess` di radice non serve).

### 3. Se usi Cloudflare (importante)

Dashboard → dominio → *Caching* → *Configuration* → **Browser Cache TTL** = **"Respect Existing Headers"** (oppure una *Cache Rule* solo per
`/madovai/` con *Browser TTL* e *Edge TTL* su "Respect origin"). Il valore predefinito (4 ore) riscrive l'intestazione `Cache-Control` e i browser
terrebbero per ore le vecchie versioni dell'app. Dopo un cambio: *Purge Everything*.

### 4. Verifica

```bash
curl -s "https://TUODOMINIO/madovai/js/version.js?x=$(date +%s)"            # deve mostrare la versione attesa (es. 1.1.0)
curl -s "https://TUODOMINIO/madovai/config.js"                                # indirizzo del backend
curl -s https://madovai.gab8bit.net/health                                    # {"ok":true,"gtfsReady":true,…} = backend pronto
```

Sul telefono apri `https://TUODOMINIO/madovai/`; **iPhone**: Condividi → *Aggiungi alla schermata Home* e apri l'app da lì (serve per le notifiche);
**Android/Chrome**: menu → *Installa app*. Controlla la versione in Mappa → ⓘ Info → Versione.

Se dopo un aggiornamento vedi ancora la versione vecchia, è una cache: *Purge* su Cloudflare, poi ricarica forzata (⌘⇧R) o chiudi e riapri l'app
dallo switcher (due volte). Il server dichiara JS/CSS/HTML sempre da riconfermare e il service worker prende prima la rete.

## Passaggio dal vecchio backend PHP al backend Node (una volta sola)

Se avevi installato la versione 1.0.x (PHP + cron sul server Apache), questi passaggi la sostituiscono. **Ordine importante.**

1. **Ferma i cron del PHP** (sul server Apache). Se restassero attivi, ogni promemoria arriverebbe **due volte** (PHP e backend Node):

   ```bash
   sudo -u www-data crontab -l | grep -v madovai | sudo -u www-data crontab -
   ```

   Filtra via ogni riga che contiene `madovai` (`remind.php` e `build-data.php`) e reinstalla il resto. Se quelle erano le uniche righe puoi usare `sudo -u www-data crontab -r`.

2. **Porta con te i promemoria e la chiave delle notifiche** (facoltativo ma consigliato). Dal server Apache copia `state.sqlite` e `vapid.json` nella cartella dati del
   backend (`~/docker/madovai-backend/data/` per OrbStack sul Mac, o il volume dati sulla VM) **con il backend fermo**, poi riavvialo:

   ```bash
   scp UTENTE@HOST:/var/www/madovai-data/state.sqlite UTENTE@HOST:/var/www/madovai-data/vapid.json ~/docker/madovai-backend/data/
   cd ~/docker/madovai-backend && docker compose restart
   ```

   - `vapid.json` è la chiave con cui il server firma le notifiche: se il backend usa **la stessa**, i telefoni che hanno già attivato le notifiche continuano
     a riceverle senza fare nulla. Se invece il backend ha già generato una **chiave sua** (lo vedi con `curl https://madovai.gab8bit.net/api/v1/push/config`:
     la `publicKey` è diversa da quella nel vecchio `vapid.json`), non copiare `vapid.json`: ogni dispositivo dovrà riattivare le notifiche una volta (punto 4).
   - `state.sqlite` contiene le sottoscrizioni e i promemoria già salvati.

3. **Carica la nuova PWA** (passo 1 della sezione Installazione) e **rimuovi i vecchi file PHP** dal server (l'`rsync` non li tocca, vedi sopra):

   ```bash
   cd /var/www/html/madovai && sudo rm -rf src bin tests data docs config.php config.sample.php public/api public/router.php
   ```

   Cancella solo il codice PHP dentro la cartella del sito (sono tutti percorsi relativi a `/var/www/html/madovai`). Il database e le chiavi del PHP stanno fuori, in
   `/var/www/madovai-data`, e non vengono toccati (li elimini al passo 5). Se un `rm` dà "No such file", ignoralo: vuol dire che non c'era.

4. **Sui dispositivi**: apri l'app (due volte, vedi sopra). Se la chiave delle notifiche è cambiata, in *Promemoria* compare di nuovo **Attiva**: toccalo una volta.
   L'app riconosce da sola una sottoscrizione fatta con la vecchia chiave e la rifà. I promemoria salvati sul telefono vengono rinviati al backend a ogni apertura
   (il backend ne tiene solo una copia per sapere quando notificare), quindi si ripristinano da soli.

5. **Pulizia (quando sei sicuro che va tutto)**: `sudo rm -rf /var/www/madovai-data` sul server Apache elimina il vecchio database, le chiavi e la cache del PHP.
   **È irreversibile**: fallo dopo aver verificato le notifiche con il backend nuovo.

## Disinstallazione dal server

```bash
sudo rm -rf /var/www/html/madovai
```

Rimuove la PWA (sono solo file statici). Il backend si ferma e si cancella a parte (vedi la sua documentazione). I telefoni mantengono l'app installata:
va tolta a mano dalla Home. Facoltativo, solo se nessun altro progetto li usa: `sudo a2dismod rewrite` e ripristino di `AllowOverride None`.

## Dove sono salvati i dati degli utenti

Non ci sono account né login. Ogni cosa vive nel browser del singolo dispositivo:

| Dato | Dove | Cambiando dispositivo / cancellando i dati del sito |
|---|---|---|
| **Preferiti** | Solo nel browser (`localStorage`). Il backend non li vede. | Si perdono: ogni dispositivo ha i suoi. |
| **Promemoria** | Nel browser, più una copia sul backend che serve a mandare le notifiche all'orario giusto. | Si perdono sul nuovo dispositivo. La copia sul backend resta associata al vecchio browser. |
| **Notifiche push** | Il browser crea una *sottoscrizione* anonima (un indirizzo fornito da Apple/Google/Mozilla); il backend associa i promemoria a quella, non a una persona. | Ogni dispositivo va attivato a parte. |

Il backend non conosce nome, email o posizione degli utenti. La posizione GPS resta sul telefono e non viene mai inviata.

## Notifiche (Promemoria)

Sull'app iOS i promemoria usano `BGAppRefreshTask`; sul web non esiste, quindi il lavoro lo fa il backend: ogni minuto cerca i promemoria dovuti, recupera il
prossimo passaggio (Cotral / ASTRAL / GTFS-RT) e invia una **Web Push** cifrata. Se il recupero fallisce non invia nulla, riprova dopo 2 minuti fino a 15
volte e poi rinuncia fino al giorno successivo — come su iOS.

Limiti reali:
- **iPhone/iPad (iOS ≥ 16.4)**: le notifiche push web funzionano **solo** se Madovai è stata aggiunta alla schermata Home e aperta da lì.
- L'utente deve concedere il permesso notifiche (richiesto al primo salvataggio di un promemoria).
- La consegna dipende dal servizio push del browser (Apple/Google/Mozilla): di norma è immediata, ma non garantita.
- I promemoria sono associati al browser/dispositivo (nessun account): cancellare i dati del sito li fa smettere.

## Sviluppo locale

```bash
php -S 127.0.0.1:8099 -t public        # oppure: python3 -m http.server 8099 -d public   →  http://127.0.0.1:8099
```

L'app chiama il backend di `public/config.js`. Per provarla contro un backend locale (`npm run dev` nel progetto backend, porta 3000) cambia temporaneamente
`apiBase` in `http://localhost:3000/api/v1` (il CORS di default lo permette).

## Crediti e licenze

- Dati trasporto Roma: Roma Servizi per la Mobilità (romamobilita.it), CC-BY 3.0 Italia.
- Dati Cotral: endpoint e feed GTFS pubblici di Cotral S.p.A.; orari treni: ASTRAL S.p.A.
- Mappa: © OpenStreetMap contributors (tile standard di tile.openstreetmap.org: uso leggero consentito, vedi la [tile usage policy](https://operations.osmfoundation.org/policies/tiles/);
  per traffico alto cambia `TILE_URL` in `public/js/map/MapController.js`).
- Librerie incluse in `public/vendor/`: Leaflet (BSD-2), htm + Preact (Apache-2.0 / MIT), icone Lucide (ISC).
