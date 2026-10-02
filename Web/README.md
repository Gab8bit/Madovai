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

- Apache 2.4 (`mod_rewrite` non serve), HTTPS (necessario per geolocalizzazione, PWA e notifiche push).
- PHP **8.1+** con le estensioni: `pdo_sqlite`, `curl`, `openssl`, `mbstring`, `zip` (o il binario `unzip`). Nessun Composer.
- Spazio disco: ~300 MB per `data/madovai.sqlite`; RAM per il build dei dati: ~512 MB (solo da CLI).
- `cron` per aggiornare i dati e inviare i promemoria.

## Installazione

1. **Carica** il progetto sul server. Imposta il `DocumentRoot` (o un `Alias`) su `public/`. Esempio vhost:

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

   Se invece lo metti in una sottocartella di un sito esistente, i file `.htaccess` in `src/`, `data/`, `bin/`, `docs/`, `tests/`
   negano l'accesso web (`AllowOverride All` necessario). Meglio comunque tenere `data/` fuori dalla web root (vedi `data_dir`).

2. **Permessi**: l'utente del web server (es. `www-data`) deve poter scrivere in `data/`.

   ```bash
   chown -R www-data:www-data data
   ```

3. **Configurazione (opzionale)**: copia `config.sample.php` in `config.php` e imposta almeno `vapid_subject`
   (un `mailto:` tuo, richiesto dai servizi push) ed eventualmente `data_dir`.

4. **Genera i dati statici** (scarica i 3 feed GTFS ed elabora, ~2-3 minuti):

   ```bash
   sudo -u www-data php bin/build-data.php
   ```

5. **Chiavi per le notifiche push** (una volta sola):

   ```bash
   sudo -u www-data php bin/gen-vapid.php
   ```

6. **Cron** (`sudo -u www-data crontab -e`):

   ```cron
   # promemoria: ogni minuto
   * * * * * php /var/www/madovai/bin/remind.php >> /var/www/madovai/data/remind.log 2>&1
   # dati statici: ogni notte alle 04:30 (i feed cambiano raramente)
   30 4 * * * php /var/www/madovai/bin/build-data.php >> /var/www/madovai/data/build.log 2>&1
   ```

7. Apri `https://madovai.example.it/` dal telefono e usa **Condividi → Aggiungi alla schermata Home** (iPhone) o
   "Installa app" (Android/Chrome).

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
