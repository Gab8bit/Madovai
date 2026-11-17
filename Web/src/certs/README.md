# Certificati inclusi

`sectigo-ov-r36.pem` — intermedio "Sectigo Public Server Authentication CA OV R36" (emesso da "Sectigo Public Server
Authentication Root R46", valido fino al 21/03/2036). `gestionecorse.astralspa.it` (orari/ritardi dei treni Cotral) invia
la catena TLS **senza** questo intermedio; browser e iOS lo recuperano via AIA, PHP/cURL no.

- Scaricato il 2026-10-02 da http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt (URL "CA Issuers" del certificato di ASTRAL).
- SHA-256: `65:42:D1:76:BE:D5:0F:19:3C:0C:E2:97:AE:44:EC:D8:A0:A8:6B:EC:2E:DE:68:27:69:34:40:59:B4:E7:85:30`
- Verificato con `openssl verify -CAfile <bundle Mozilla> -untrusted sectigo-ov-r36.pem <certificato ASTRAL>` → OK.
- Usato **solo** per le richieste verso ASTRAL (`AstralRepository`), aggiunto al bundle CA di sistema: la verifica TLS non è mai disattivata.
- Quando ASTRAL rinnoverà/cambierà CA, se i treni smettono di caricarsi riscaricare il nuovo intermedio dall'URL AIA del certificato.
