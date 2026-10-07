# Automatische Registrierung neuer Worker-Macs

Der Worker-Installer verwendet die bereits eingerichtete SSH-Verbindung zum RS Hub.
Ein dort ausgeführter Enrollment-Befehl liefert die gemeinsame Server-Adresse und
Team-ID zusammen mit einem **eigenen Mitglieds-Token für diesen Mac**. Der
Team-Inhaber-Token bleibt ausschließlich auf dem Hub. Er gehört weder ins Git-Repo
noch in einen Download-Befehl, in die Worker-Konfiguration oder auf die neuen Macs.

## Einmal auf dem gemeinsamen Server vorbereiten

1. Den aktualisierten Team-Relay mit `/workers/enroll` und `/fleet` bereitstellen.
   Die bestehende `DATA_DIR`-Ablage muss erhalten bleiben. Für diese dateibasierte
   Ablage genau eine Relay-Instanz betreiben; mehrere Prozesse mit derselben Ablage
   sind kein unterstütztes Setup.
2. Auf dem RS Hub den Max-Monitor-Checkout unter `/opt/max-monitor` bereitstellen.
   Der Enrollment-Befehl importiert `team-server/enrollment.js` aus diesem Checkout.
3. Die Werte über `MAX_MONITOR_SERVER_URL`, `MAX_MONITOR_TEAM_ID` und
   `MAX_MONITOR_OWNER_TOKEN` ausschließlich in der Umgebung des Hub-Befehls
   konfigurieren. Alternativ die private Datei
   `/etc/max-monitor/enrollment.json` mit Modus `600` verwenden:

   ```json
   {
     "serverURL": "https://monitor.example.org",
     "teamId": "DEMO1234",
     "ownerToken": "<nur auf dem Hub eintragen>"
   }
   ```

4. Mit dem gleichen Hub-SSH-Benutzer wie im Worker-Setup prüfen:

   ```bash
   node /opt/max-monitor/scripts/enroll-monitor-worker.mjs --check
   ```

   Das prüft ausschließlich Konfiguration, Inhaber-Berechtigung sowie die beiden
   benötigten Relay-Endpunkte. Es legt kein Mitglied an und gibt keinen Token aus.
   Wenn Konfiguration oder die aktualisierten Endpunkte fehlen, bricht der
   Worker-Installer ab, bevor er ein neues Monitor-Mitglied anlegt.

## Was das Worker-Setup automatisch macht

Die Monitor-App stellt ihre dauerhaft gespeicherte Geräte-UUID bereit. Der
Installer übermittelt diese UUID zusammen mit der bereits vorhandenen
`worker_id` der Newsletter-Konfiguration über SSH an den festen Hub-Befehl:

```bash
node /opt/max-monitor/scripts/enroll-monitor-worker.mjs --stdin
```

Das JSON auf stdin hat `workerId`, `deviceId` und optional `name`. `deviceId`
ist die UUID aus `FleetSettings` der App. Hardware-UUID oder ein bei jedem Setup
neu erzeugter Wert dürfen hier nicht als Ersatz verwendet werden.

Die Antwort auf stdout ist ein einzelnes JSON-Objekt mit `schema`, `serverURL`,
`teamId`, `token`, `memberId`, `workerId` und `deviceId`. Der Installer fängt diese
Antwort vertraulich auf und importiert sie in die App; sie wird nicht im Terminal
protokolliert. Fehlerantworten geben weder den Inhaber-Token noch fremde
Mitglieds-Tokens aus.

## Wiederholung, Mac 6 und Austausch eines Geräts

Dasselbe Setup auf demselben Mac mit derselben Worker-ID liefert wieder denselben
Mitglieds-Token. Gleichzeitige Wiederholungen erzeugen innerhalb der Relay-Instanz
keine Duplikate. Ein weiterer Mac erhält eine eigene Worker-ID, Geräte-UUID und
einen anderen Token; alle sehen trotzdem dieselbe gemeinsame Fleet und Queue.

Wenn dieselbe Worker-ID mit einer anderen Geräte-UUID gemeldet wird, bricht die
Registrierung mit `409` ab. Auch eine zweite Worker-ID für dieselbe Geräte-UUID
wird abgelehnt. Bei einem echten Geräteaustausch muss der Inhaber die bestehende
Mitglieds-Zuordnung bewusst entfernen beziehungsweise prüfen. Der Installer
kopiert keine Identität von einem anderen Mac.

Ein automatisch registrierter Worker hat Rolle `member`. Sein Token darf seine
Gerätemeldungen schreiben und die gemeinsame Übersicht lesen. Er darf keine
Mitglieder anlegen, Mitglieds-Tokens lesen oder die zentrale Aufgaben-Queue
überschreiben. Seine Heartbeats müssen die registrierte Worker-ID und
Geräte-UUID verwenden.

## Lokale Prüfung

```bash
npm --prefix team-server test
node --test scripts/enroll-monitor-worker.test.mjs
```

Die Tests prüfen unter anderem gleichzeitige Wiederholung, Gerätebindung,
getrennte Tokens, fehlende Inhaber-Rechte, erhaltene Tokens nach Neustart,
beschädigte Ablagen und vertrauliche Fehlerausgaben.
