# Madovai Web

Versione web (PWA) di **Madovai** — bus, tram, metro e treni di Roma e del Lazio in tempo reale
(Cotral, Atac, Roma TPL). Stesse funzioni e stessa interfaccia dell'app iOS, installabile dalla Home del telefono,
pensata per girare su un normale server **Apache2 + PHP**.

- **Mappa** con paline Cotral, fermate e linee Atac/Roma TPL, veicoli in movimento, ricerca di fermate e linee, "segui questo bus".
- **Linee**, **Preferiti**, **Promemoria** (notifica push sul prossimo bus/treno a giorni e orari scelti).
- Tema chiaro/scuro automatico, materiali "liquid glass" in CSS, tab bar in basso.

## Come è fatto

```
public/   ← la cartella da pubblicare (DocumentRoot): frontend statico (Preact+htm, Leaflet) + public/api/*.php
src/      ← libreria PHP (nessuna dipendenza, nessun Composer)
bin/      ← script da riga di comando (build dati, cron promemoria, chiavi push)
data/     ← database SQLite + cache (scrivibile dal web server; NON pubblica)
docs/     ← API.md: contratto tra backend e frontend
tests/    ← test PHP (php tests/php/run.php  /  php tests/php/push/run_all.php)
```

Perché serve un backend (non basta un sito statico): Cotral risponde solo in **HTTP e senza CORS** (una pagina HTTPS
non può chiamarlo), i feed GTFS pesano centinaia di MB (Atac 235 MB di `stop_times`) e il GTFS-Realtime di Roma Mobilità
va decodificato e messo in cache una volta sola per tutti i visitatori. Il server pre-elabora i dati statici in SQLite
e fa da proxy/cache verso i feed live; il browser scarica solo JSON leggeri.

## Requisiti del server

- Apache 2.4 con `mod_rewrite`, `mod_headers`, `mod_deflate`, e **HTTPS** (necessario per geolocalizzazione, installazione come app e notifiche).
- PHP **8.1+** con le estensioni `pdo_sqlite`, `curl`, `openssl`, `mbstring`, `zip`. Nessun Composer.
- ~300 MB di disco per il database (`madovai.sqlite` ~106 MB, più la cache) e ~250 MB di RAM per il build dei dati (solo da riga di comando).
- `cron`.

## Installazione (ogni comando spiegato)

Nei comandi: `UTENTE@HOST` = utente SSH e indirizzo del server; `/var/www/html/madovai` = cartella del sito (cambiala se vuoi);
`/var/www/madovai-data` = cartella dei dati; `www-data` = utente con cui gira Apache (su Debian/Ubuntu).

### 0. Estensioni PHP (una volta sola, sul server)

```bash
sudo apt update && sudo apt install -y php-sqlite3 php-curl php-mbstring php-zip
php -m | grep -i -E "pdo_sqlite|curl|mbstring|zip|openssl"
```

- `php-sqlite3`: il database dei dati statici (linee, fermate, orari) è un file SQLite. Senza, il build si ferma con "could not find driver".
- `php-curl`: scarica i feed di Cotral, ASTRAL e Roma Mobilità e manda le notifiche push.
- `php-mbstring`: gestione corretta di accenti e maiuscole nelle ricerche.
- `php-zip`: legge i feed GTFS, che sono archivi `.zip` (in alternativa serve il comando `unzip`).
- `openssl` è già incluso in PHP: serve a cifrare le notifiche push.
- `php -m` elenca i moduli attivi: devi vedere tutti e cinque.

### 1. Upload (dal tuo Mac, nella cartella del progetto)

```bash
rsync -avz --delete --exclude='.git' --exclude='.claude' --exclude='tests' --exclude='data/*' --exclude='config.php' --exclude='project-info.json' --exclude='.DS_Store' ./ UTENTE@HOST:/var/www/html/madovai/
```

- `rsync` copia solo ciò che è cambiato (veloce anche negli aggiornamenti successivi), via SSH.
- `-a` conserva permessi e date, `-v` mostra i file, `-z` comprime durante il trasferimento.
- `--delete` cancella sul server i file che hai tolto in locale, così le due cartelle restano identiche.
- Le `--exclude` evitano di copiare: la cronologia git, i test, i dati e **`config.php`**, che esiste solo sul server
  (con `--delete`, senza questa esclusione verrebbe cancellato a ogni aggiornamento). Lo stesso vale per `project-info.json`:
  se la pagina indice del tuo server lo usa per elencare i progetti, `--delete` lo cancellerebbe. Aggiungi un'`--exclude` per ogni altro file che esiste solo sul server.
- Se l'utente SSH non può scrivere in `/var/www/html`, prima: `ssh UTENTE@HOST 'sudo mkdir -p /var/www/html/madovai && sudo chown UTENTE: /var/www/html/madovai'`
  (crea la cartella e ne rende proprietario il tuo utente).

### 2. Apache (sul server)

Due modi di pubblicare:

**A) Sottocartella di un sito esistente** (`https://tuodominio/madovai/`). È il caso della cartella `/var/www/html/madovai`:
l'`.htaccess` nella radice del progetto serve ogni richiesta da `public/` e nasconde `src/`, `bin/`, `docs/`, `tests/` e `config.php`.

```bash
sudo a2enmod rewrite headers deflate
sudo sed -i '/<Directory \/var\/www\/>/,/<\/Directory>/ s/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf
sudo systemctl restart apache2
```

- `a2enmod`: attiva i moduli Apache. `rewrite` esegue la regola che redirige verso `public/`; `headers` imposta le intestazioni di cache e
  sicurezza; `deflate` comprime le risposte (JSON e JS più piccoli, importante su connessioni lente).
- Il `sed` cambia `AllowOverride None` in `AllowOverride All` nel blocco `<Directory /var/www/>`: senza, Apache **ignora tutti i
  file `.htaccess`** e il progetto non funzionerebbe (né sarebbero nascosti `src/` e simili). Nota: vale per tutti i progetti in
  `/var/www`; se non vuoi, applicalo solo a `/var/www/html/madovai` in un file in `/etc/apache2/conf-available/`.
- `restart` (non `reload`) serve perché hai appena attivato dei moduli nuovi.

**B) Dominio o vhost dedicato**: imposta il `DocumentRoot` su `public/`:

```apache
<VirtualHost *:443>
    ServerName madovai.example.it
    DocumentRoot /var/www/madovai/public
    <Directory /var/www/madovai/public>
        AllowOverride All
        Require all granted
    </Directory>
    # SSL ...
</VirtualHost>
```

### 3. Cartella dei dati (sul server)

```bash
sudo mkdir -p /var/www/madovai-data && sudo chown -R www-data:www-data /var/www/madovai-data
```

- Crea la cartella che conterrà il database, la cache, le sottoscrizioni delle notifiche e la **chiave privata** delle notifiche.
- Sta **fuori** dalla web root apposta: così non è mai raggiungibile da internet, nemmeno se un `.htaccess` smettesse di funzionare.
- `chown … www-data`: Apache e i comandi lanciati come `www-data` devono poterci scrivere.

### 4. Configurazione (sul server)

```bash
cd /var/www/html/madovai && cp config.sample.php config.php
sed -i "s#// 'data_dir' => .*#'data_dir' => '/var/www/madovai-data',#; s#mailto:admin@example.com#mailto:TUA@EMAIL#" config.php
```

- `config.php` è il file di configurazione locale (non è nel repository: è diverso per ogni server).
- Il primo `sed` attiva `data_dir`, cioè dice all'app di usare la cartella del punto 3.
- Il secondo imposta `vapid_subject`: un contatto (`mailto:…` oppure un URL `https://…`) che il tuo server comunica ai servizi push di Apple/Google/Mozilla
  insieme a ogni notifica, per poterti contattare se qualcosa va storto. Apple rifiuta le notifiche se manca o non è valido. Non è un account e
  non è visibile agli utenti.

### 5. Dati statici (sul server)

```bash
sudo -u www-data php bin/build-data.php
```

- Scarica i tre feed GTFS (Cotral bus, Cotral treni, Atac/Roma TPL, ~75 MB) e li trasforma nel database SQLite. Dura 1-2 minuti.
- `sudo -u www-data` lo esegue come l'utente di Apache, così i file creati hanno i permessi giusti.
- È necessario perché i feed originali pesano centinaia di MB: il browser dei visitatori non può scaricarli, quindi il server li prepara una volta.

### 6. Chiavi per le notifiche (sul server, una volta sola)

```bash
sudo -u www-data php bin/gen-vapid.php
```

- Genera la coppia di chiavi (standard VAPID) con cui il server firma e cifra le notifiche push. La parte privata resta in `/var/www/madovai-data/vapid.json`.
- **Non rilanciarlo**: cambiare chiave invalida le notifiche già attivate sui telefoni degli utenti.

### 7. Cron (sul server)

```bash
(sudo -u www-data crontab -l 2>/dev/null; echo '* * * * * php /var/www/html/madovai/bin/remind.php >> /var/www/madovai-data/remind.log 2>&1'; echo '30 4 * * * php /var/www/html/madovai/bin/build-data.php >> /var/www/madovai-data/build.log 2>&1') | sudo -u www-data crontab -
```

- Aggiunge due attività pianificate all'utente `www-data`, **senza cancellare quelle già presenti** (`crontab -l` legge le esistenti, `echo` ne aggiunge, `crontab -` reinstalla l'insieme).
- `* * * * *` (ogni minuto) → `remind.php`: controlla i promemoria in scadenza, recupera il prossimo bus/treno e manda la notifica. Senza questa riga i promemoria non partono mai.
- `30 4 * * *` (ogni notte alle 04:30) → `build-data.php`: ricostruisce il database con gli orari aggiornati. I feed cambiano di rado, quindi una volta al giorno basta.
- `>> file.log 2>&1` salva l'output (e gli errori) in un file di log invece di perderlo: utile se qualcosa non funziona.

### 8. Verifica (sul server)

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/madovai/            # 200 = il sito risponde
curl -s http://localhost/madovai/api/lines.php | head -c 150; echo             # JSON = backend e database ok
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/madovai/config.php    # 404 = file protetto
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/madovai/src/Config.php # 404 = codice non esposto
curl -s "http://localhost/madovai/api/rail.php?stop=RL_ACILIA" | head -c 120; echo   # "source":"astral" = treni in tempo reale ok
sudo -u www-data crontab -l                                                      # le due righe del punto 7
sudo -u www-data php bin/remind.php --dry-run --verbose                          # prova a secco dei promemoria
```

### 9. Sul telefono

Apri `https://tuodominio/madovai/`. Su iPhone: Condividi → **Aggiungi alla schermata Home**, poi apri l'app da lì (serve per le notifiche).
Su Android/Chrome: menu → **Installa app**. Poi vai in Promemoria → Attiva → Prova.

## Aggiornare l'app

Se dopo un aggiornamento vedi ancora la versione vecchia, è quasi sempre una cache. Controlla la versione in **Mappa → ⓘ Info → Versione**
(deve coincidere con `APP_VERSION` in `public/js/version.js`). Se non coincide:

1. **Cloudflare** (se usi un tunnel o il proxy): Dashboard → dominio → *Caching* → *Configuration* → **Purge Everything**.
   Cloudflare mette in cache di default `.js`, `.css` e immagini, anche sul bordo della rete.
2. **Browser**: ricarica forzata (⌘⇧R su Mac). Su iPhone, chiudi l'app dallo switcher e riaprila; se non basta, Impostazioni →
   Safari → Avanzate → Dati dei siti web → rimuovi il dominio.
3. Verifica cosa serve davvero il server:

   ```bash
   curl -sI https://TUODOMINIO/madovai/js/ui/Sheet.js | grep -i -E "cache-control|cf-cache-status|last-modified|etag"
   ```

   `cache-control: no-cache` è corretto (il browser deve riconfermare ogni volta, con una risposta 304 minuscola quando il file non è cambiato).
   `cf-cache-status: HIT` insieme a un `last-modified` vecchio significa che sta rispondendo la cache di Cloudflare.

Dalla versione 1.0.4 il server dichiara JS/CSS/HTML sempre da riconfermare e il service worker prende prima la rete (la cache solo offline o se la
rete non risponde entro 4 secondi), quindi gli aggiornamenti arrivano alla prima apertura.

Dal Mac, rilancia lo stesso `rsync` del punto 1 (non tocca `config.php` né i dati). Se è cambiato qualcosa lato server non serve altro:
Apache usa subito i nuovi file. Gli utenti con l'app installata ricevono la nuova versione alla successiva apertura (a volte alla seconda).
Per forzare subito un aggiornamento dei dati: `sudo -u www-data php /var/www/html/madovai/bin/build-data.php`.

## Disinstallazione dal server

```bash
# 1. Rimuove dal cron le righe di Madovai (lascia intatte le altre)
sudo -u www-data crontab -l | grep -v madovai | sudo -u www-data crontab -

# 2. Cancella il sito
sudo rm -rf /var/www/html/madovai

# 3. Cancella dati, cache, chiavi VAPID e sottoscrizioni push degli utenti
sudo rm -rf /var/www/madovai-data
```

- Il punto 1 filtra via ogni riga che contiene `madovai` e reinstalla il resto. Se quelle erano le uniche righe, puoi usare `sudo -u www-data crontab -r` (cancella tutto il crontab di `www-data`).
- Il punto 3 è **irreversibile**: elimina la chiave privata delle notifiche. I promemoria degli utenti smettono di arrivare (l'app sul telefono resta installata:
  va tolta a mano dalla Home).

Facoltativo, **solo se nessun altro progetto li usa** (altrimenti lasciali):

```bash
sudo apt remove -y php-sqlite3 php-zip                                    # estensioni PHP installate per Madovai
sudo a2dismod rewrite                                                    # disattiva mod_rewrite
sudo sed -i '/<Directory \/var\/www\/>/,/<\/Directory>/ s/AllowOverride All/AllowOverride None/' /etc/apache2/apache2.conf   # ripristina l'impostazione originale
sudo systemctl restart apache2
```

## Dove sono salvati i dati degli utenti

Non ci sono account né login. Ogni cosa vive nel browser del singolo dispositivo:

| Dato | Dove | Cambiando dispositivo / cancellando i dati del sito |
|---|---|---|
| **Preferiti** | Solo nel browser (`localStorage`). Il server non li vede. | Si perdono: ogni dispositivo ha i suoi. |
| **Promemoria** | Nel browser, più una copia sul server (`state.sqlite`) che serve a mandare le notifiche all'orario giusto. | Si perdono sul nuovo dispositivo. La copia sul server resta associata al vecchio browser. |
| **Notifiche push** | Il browser crea una *sottoscrizione* anonima (un indirizzo fornito da Apple/Google/Mozilla); il server associa i promemoria a quella, non a una persona. | Ogni dispositivo va attivato a parte. |

Il server non conosce nome, email o posizione degli utenti. La posizione GPS resta sul telefono e non viene mai inviata.

## Notifiche (Promemoria)

Sull'app iOS i promemoria usano `BGAppRefreshTask`; sul web non esiste, quindi il lavoro lo fa il server: ogni minuto
`bin/remind.php` cerca i promemoria dovuti, recupera il prossimo passaggio (Cotral / ASTRAL / GTFS-RT) e invia una
**Web Push** cifrata (VAPID, RFC 8291, implementata con la sola estensione `openssl`). Se il recupero fallisce non invia nulla,
riprova dopo 2 minuti fino a 15 volte e poi rinuncia fino al giorno successivo — come su iOS.

Limiti reali:
- **iPhone/iPad (iOS ≥ 16.4)**: le notifiche push web funzionano **solo** se Madovai è stata aggiunta alla schermata Home e aperta da lì.
- L'utente deve concedere il permesso notifiche (richiesto al primo salvataggio di un promemoria).
- La consegna dipende dal servizio push del browser (Apple/Google/Mozilla): di norma è immediata, ma non garantita.
- I promemoria sono associati al browser/dispositivo (nessun account): cancellare i dati del sito li fa smettere.

## Certificato ASTRAL (orari treni)

`gestionecorse.astralspa.it` (la fonte degli orari/ritardi dei treni Cotral) invia una catena TLS **incompleta** (manca
l'intermedio Sectigo): browser e iOS lo recuperano da soli, PHP/cURL no. Il progetto include già l'intermedio verificato
in `src/certs/sectigo-ov-r36.pem` (dettagli e impronta in `src/certs/README.md`) e lo aggiunge al bundle CA di sistema
**solo** per le richieste ASTRAL: la verifica TLS non viene mai disattivata. Se un giorno i treni smettono di caricarsi
perché ASTRAL cambia CA, sostituisci il file (o mettine uno in `data/astral-ca.pem`).

## Sviluppo locale

```bash
php -S 127.0.0.1:8099 -t public public/router.php     # http://127.0.0.1:8099
php tests/php/run.php && php tests/php/push/run_all.php
```

Per provare senza toccare `data/`, imposta `MADOVAI_DATA_DIR=/percorso/temporaneo`.

## Crediti e licenze

- Dati trasporto Roma: Roma Servizi per la Mobilità (romamobilita.it), CC-BY 3.0 Italia.
- Dati Cotral: endpoint e feed GTFS pubblici di Cotral S.p.A.; orari treni: ASTRAL S.p.A.
- Mappa: © OpenStreetMap contributors (tile standard di tile.openstreetmap.org: uso leggero consentito, vedi la [tile usage policy](https://operations.osmfoundation.org/policies/tiles/); per traffico alto cambia `TILE_URL` in `public/js/map/MapController.js`).
- Librerie incluse in `public/vendor/`: Leaflet (BSD-2), htm + Preact (Apache-2.0 / MIT), icone Lucide (ISC).
