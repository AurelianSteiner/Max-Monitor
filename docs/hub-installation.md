# Gemeinsamen Max-Monitor-Dienst auf RS Hub einrichten

Der R&S-Dienst wurde am **7. Oktober 2026** unter
`https://api.ruegamer-steiner.de/max-monitor` mit Team `RSMACS01` eingerichtet.
Relay, öffentlicher HTTPS-Zugriff, automatische Registrierung und ein vollständiger
Queue-Abgleich wurden auf dem Hub geprüft. Neue Macs holen diese Einstellungen
automatisch; die folgenden Schritte sind für die zentrale Wartung gedacht.

Der Installer ergänzt einen eigenen Dienst und ausschließlich den Pfad
`https://api.ruegamer-steiner.de/max-monitor`. Der Relay hört auf
`127.0.0.1:8941`, läuft als eigener Benutzer `max-monitor` und speichert unter
`/var/lib/max-monitor`. Ein zweiter Dienst aktualisiert die gemeinsame Queue
alle 60 Sekunden direkt auf dem Hub; sein Cache liegt unter
`/var/lib/max-monitor-queue`. Bestehende RS-Hub-Daten und API-Routen werden nicht
als Installationsziele verwendet.

## Vorbereitung und Vorschau

Den aktuellen Checkout mit den Installationsskripten auf den Hub übertragen.
Node.js ab Version 20, systemd und die vorhandene nginx-TLS-Konfiguration werden
benötigt. Der Installer verlangt den Pfad zu dieser Konfiguration ausdrücklich;
auf dem aktuellen Hub ist das `/etc/nginx/sites-available/rs-configs`.

Zuerst einen privaten Vorschauordner erstellen:

```bash
bash scripts/install-monitor-hub.sh \
  --generate-only /root/max-monitor-install-review \
  --nginx-config /etc/nginx/sites-available/rs-configs \
  --worker-root /root/newsletter-source
```

Dieser Schritt schreibt nur in den Vorschauordner. `plan.json` enthält die
Zieldateien und öffentliche Einstellungen. `payload/` enthält die geplanten
Dateien einschließlich privater Konfiguration; diesen Ordner nicht ins Git
übernehmen, teilen oder im Terminal vollständig ausgeben.

Der nginx-Entwurf erhält die vorhandenen Routen. Er ergänzt einen markierten
`/max-monitor/`-Block ausschließlich im bestehenden TLS-Server mit passendem
`server_name`. Der Port-80-Redirect und andere Server-Blöcke bleiben erhalten.
Bei mehrdeutiger Konfiguration, einem bereits anders belegten Monitor-Pfad oder
einem unvollständigen verwalteten Block bricht die Vorbereitung ab.

## Einrichtung

Nach Prüfung des Entwurfs auf dem Hub als root:

```bash
bash scripts/install-monitor-hub.sh \
  --install \
  --nginx-config /etc/nginx/sites-available/rs-configs \
  --worker-root /root/newsletter-source
```

Bei einem abweichenden Node-Pfad `--node-binary /absoluter/pfad/node` angeben.
Die Vorgaben sind Team `RSMACS01`, Port `8941` und die oben genannte öffentliche
Adresse. `--team-id`, `--port` und `--server-url` erlauben eine gezielte Anpassung.

`--worker-root` muss auf den geprüften Newsletter-Quellcode zeigen. Benötigt
werden ausschließlich `src/config.js`, `src/hub-transport.js` und
`src/pre-gen.js`. Der Installer kopiert diese drei Dateien und erzeugt eine
eigene minimale Monitor-Konfiguration mit `/usr/bin/false` als Claude-Binary;
er kopiert keine lokale Mac-Konfiguration und startet keinen Newsletter-Worker.

Der Installer legt einen privaten Inhaber-Token nur auf dem Hub an. Bei einer
Wiederholung übernimmt er den bestehenden Token aus
`/etc/max-monitor/enrollment.json`; bei abweichender vorhandener Server-Adresse
oder Team-ID bricht er ab. Der Token steht weder in der Ausgabe noch in
Kommandozeilenargumenten. Die App-Dateien, der Relay und der feste
Enrollment-Befehl liegen anschließend unter `/opt/max-monitor`.

Vor der Änderung werden vorhandene Zieldateien und der bisherige Dienststatus
unter `/var/backups/max-monitor/<zeitpunkt>/` privat gesichert. Danach prüft der
Installer nginx, startet den Relay, prüft dessen Enrollment- und Fleet-API über
Loopback, lädt nginx neu und prüft dieselben APIs über die öffentliche HTTPS-
Adresse. Dann startet er den zentralen Queue-Dienst und wartet auf dessen ersten
vollständigen erfolgreichen Aufgaben-Snapshot. Erst danach meldet er Erfolg.

`max-monitor-queue.service` läuft als root, um die vorhandenen Hub-Schlüssel
lesen zu können. Er verwendet den unveränderten Newsletter-Hub-Transport mit
einem lokalen Node-Prozess anstelle von SSH. Ein zusätzlicher GET-Filter
verhindert ClickUp-/Slack-Schreibzugriffe und Worker-Heartbeat-Schreibeffekte.
Der Dienst erhält nur Lesezugriff auf `/opt/rs-hub` und die private
Monitor-Konfiguration; lokale Schreibzugriffe sind auf seinen eigenen Cache
begrenzt. Die gemeinsamen Service-Schlüssel werden nicht auf Macs übertragen.

## Wiederherstellung

Bei einem Fehler nach der ersten Dateiänderung stellt der Installer die
gesicherten Dateien und den vorherigen Status beider Dienste automatisch wieder her.
Die Erfolgsausgabe enthält außerdem `rollbackDirectory`. Eine spätere bewusste
Wiederherstellung verwendet genau diesen Pfad:

```bash
node /opt/max-monitor/scripts/install-monitor-hub.mjs \
  --rollback /var/backups/max-monitor/<zeitpunkt>
```

Die persistenten Ablagen `/var/lib/max-monitor` und `/var/lib/max-monitor-queue`
werden auch beim Rollback niemals gelöscht. Neu entstandene leere Verzeichnisse und der Dienstbenutzer bleiben
erhalten. Bei mehreren Installationen die Sicherungen in umgekehrter Reihenfolge
verwenden.

## Grenzen der lokalen Prüfung

```bash
node --test scripts/install-monitor-hub.test.mjs scripts/enroll-monitor-worker.test.mjs
node --test scripts/newsletter-monitor-local-hub.test.mjs scripts/newsletter-monitor-bridge.test.mjs
npm --prefix team-server test
```

Die lokalen Tests prüfen private Dateimodi, erhaltene Tokens bei Wiederholung,
nginx-Auswahl und Konflikte, erzeugte Service-Konfiguration sowie die
Wiederherstellung von Dateien bei erhaltener Datenablage. Ob systemd, TLS,
Dateirechte und die öffentliche Adresse auf dem echten Hub funktionieren,
bestätigt erst die dortige Installation mit ihren Funktionsprüfungen.
