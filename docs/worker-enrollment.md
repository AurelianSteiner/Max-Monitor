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

## Automatischer Abgleich bestehender Macs

RS-Skills prüft Monitor-Updates alle 60 Sekunden und direkt nach der Anmeldung am Mac. Der Hintergrundmodus `--update-only` liest App-Metadaten und nicht geheime Einstellungen, bewahrt die bestehende Geräte- und Team-Zuordnung und startet die installierte App bei Bedarf. Er ruft keine native Schlüsselbund-CLI auf und registriert keine neuen Mitglieder. Die laufende App meldet die authentifizierte Verbindung jede Minute; nach einem Update wird dies über `nativeLastSeenAt` und `appVersion` in der zentralen Flotte geprüft.

Ein fehlender Einstellungsschlüssel ist nur nach einer eindeutigen `defaults`-Fehlmeldung leer. Lese- und Zeitüberschreitungsfehler brechen den normalen Abgleich ab; sie bestätigen niemals eine leere oder erhaltene Bindung. Ist dieser Leseweg blockiert, erlaubt ein ausdrücklich gewählter Wartungsaufruf `--update-only --code-only` ausschließlich den App-Code-Austausch über denselben geprüften Bundle-, Signatur-, Backup- und Rollbackweg. Er liest und schreibt keine Monitor-Einstellungen, liest keine Zugangsdaten über den nativen Monitor-CLI, registriert kein Mitglied und installiert keinen Worker-Beobachter. Beim regulären Release-Artefakt bleibt die vorhandene lokale Signieridentität wie beim normalen Update erhalten. Ergebnis und Installationsbeleg führen `bindingVerification: "required"`; ältere Identitätsfelder im Beleg sind nur Historie. Danach sind die bestehende Identität in der laufenden App und bei einem berichtenden Worker ein frischer nativer Heartbeat mit aktueller App-Version separat zu prüfen. Frische Worker-Polls allein bestätigen die native Verbindung nicht.

Vor jedem Austausch einer bestehenden App prüft auch der reine Code-Modus deren Signieranforderung gegen den Kandidaten. Fehlt die verwendbare lokale Signieridentität, darf der Download nicht still auf die Herausgeberidentität oder eine Ad-hoc-Signatur wechseln. Eine unlesbare oder nicht erfüllte bestehende Zertifikatsanforderung bricht vor dem Stoppen der App ab; bei einer vorhandenen Ad-hoc-App wird keine fremde Zertifikatsidentität eingeführt. Ein gesperrter Schlüsselbund wird durch den Updateweg nicht entsperrt.

Vor einem benötigten App-Bau oder Download sowie unmittelbar vor einem App-Austausch oder dem einmaligen Neustart alter Wartungsstände muss der vorhandene Login-Schlüsselbund nach seiner öffentlichen `SecKeychainGetStatus`-Metadatenabfrage entsperrt sein. Gesperrter, nicht erreichbarer oder unbekannter Status bricht vor dem Stoppen ab. Diese Prüfung liest keine Zugangsdaten oder Zugriffslisten und legt oder entsperrt keinen Schlüsselbund; die laufende App und ihr bestehender Bootstrap bleiben erhalten.

Bei bereits abgeschlossener lokaler Speicherung mit `PersistentCredentialVault` ist der Login-Schlüsselbund für den App-Start nicht mehr erforderlich. Der Updateweg bestätigt dafür ausschließlich eigene, reguläre Dateien mit den privaten Verzeichnis-/Dateirechten, einen 32-Byte-Schlüssel und den Abschlussmarker. Fehlt dieser Nachweis, gilt weiterhin die Schlüsselbundprüfung. Ein veröffentlichter Bundle mit Herausgeberzertifikat wird für eine bestehende Ad-hoc-Installation lokal wieder Ad-hoc signiert; zertifikatsgebundene Installationen behalten ihre exakte Zertifikatsanforderung.

Nur Änderungen an den Bauquellen der App (`Usage4Claude/`, `Usage4Claude.xcodeproj/`, `Config/Info.plist`, `Config/Usage4Claude.entitlements`, `Package.swift`, `Package.resolved`, `scripts/build_without_xcode.sh`) verlangen eine neue App; alle anderen Dateien (Hilfsskripte, Relay, Tests, Dokumentation) behalten die installierte bzw. veröffentlichte App. `Config/runtime-release-files.json` ist ein Servermanifest und ändert weder die App-Kompatibilität noch den nativen Wiederholungsschlüssel. Eine neue Bauquelle muss in diese Liste in `scripts/setup-mac-monitor.mjs` aufgenommen werden. Eine native Änderung braucht im selben Push ein neues `releases/worker-native.json` (`scripts/release.sh`), sonst baut jeder Mac selbst. Schlägt dieser Bau fehl, nennt die Fehlermeldung die Ursache aus der Bauausgabe (das ❌-Urteil des Bauskripts, sonst die letzte Compilermeldung mit Datei und Zeile, sonst die letzte Fehlerzeile; höchstens 200 Zeichen), und `--update-only` merkt sich den nativen Stand, die Swift-Version und diese Ursache. Denselben Bau mit demselben Compiler versucht es erst nach sechs Stunden erneut; die installierte App bleibt unverändert. Diese Zurückstellung ist kein Fehler (Fehleraudit 17.10.2026): Der Lauf endet mit Exit 0, schreibt „Max Monitor bauen zurückgestellt …“ und als letzte Zeile JSON `{"mode":"deferred","deferred":true,"reason":"build_failed","failedAt":…,"retryAt":…,"cause":…}` auf stdout. Jeder gescheiterte Hintergrundabgleich, auch vor der App-Prüfung (Worker-Profil, Release-Manifest), steht zusätzlich als `lastFailure` (`at`, `message`, `since`, `count`) in `installation.json`; ein späterer Erfolg ergänzt nur `recoveredAt`, damit auch ein vereinzelter Fehler später erklärbar bleibt.

## Was das Worker-Setup automatisch macht

Vor der Einrichtung prüft das Onboarding den Anzeigenamen und die Farbe anhand
der exakten Worker-ID in `team-server/worker-identities.json` auf dem Hub. Neue
Macs dort mit dem vereinbarten Namen, `color` und `textColor` als Hexfarben
ergänzen und bereitstellen. Fehlende Zuordnungen stoppen die Einrichtung vor
App-Änderungen; ein ausdrücklich als `personal` geführter Mac behält seine
persönliche Anzeige. Der macOS-Rechnername dient nicht als Anzeigename.

Die Registrierung übernimmt den zentralen Namen auch für bestehende Mitglieder
und bewahrt Token, Rolle, MacWorker-Freigabe und Gerätebindung. Das Setup liest
Name und Farbe nach der Registrierung erneut aus der gemeinsamen Fleet zurück.
Auch die bereits verbundene Einrichtung führt diesen Abgleich aus; `--check`
prüft die zentrale Zuordnung ausschließlich lesend. Der Hintergrundmodus
`--update-only` bleibt ein reines App-Update und registriert keine Mitglieder.

Der Abschluss umfasst die echte Übersicht und Mitgliederliste: genau ein Mac
mit der richtigen Worker-ID, dem vereinbarten Namen und seiner Farbhinterlegung.
Zusätzlich erzeugt `scripts/worker-wallpaper.mjs` aus derselben zentralen Farbe
ein einfarbiges sRGB-PNG unter `~/Pictures/MacWorker/` und setzt es per macOS
auf allen angeschlossenen Bildschirmen. Die Einrichtung liest die tatsächlich
gesetzten Bildpfade pro Bildschirm zurück und prüft die gespeicherte Bildfarbe.
Bei erneuter Einrichtung wird dies wieder geprüft und bei Bedarf berichtigt.
`--check` liest ausschließlich; `--update-only` ändert den Desktop nicht.
Ein expliziter persönlicher Mac ohne Mac-Farbe behält seinen Hintergrund.
Ein Fehler beim Hintergrund bleibt als offener Einrichtungspunkt sichtbar und
setzt weder die bereits gespeicherte Monitor-Verbindung noch laufende Arbeit zurück.

Die Monitor-App stellt ihre dauerhaft gespeicherte Geräte-UUID bereit. Der
Installer übermittelt diese UUID zusammen mit der bereits vorhandenen
`worker_id` der Newsletter-Konfiguration über SSH an den festen Hub-Befehl:

```bash
node /opt/max-monitor/scripts/enroll-monitor-worker.mjs --stdin
```

Das JSON auf stdin hat `workerId`, `deviceId` und optional `name`. `deviceId`
ist die UUID aus `FleetSettings` der App. Hardware-UUID oder ein bei jedem Setup
neu erzeugter Wert dürfen hier nicht als Ersatz verwendet werden.
Das Onboarding setzt zusätzlich `requireIdentity: true`. Der Hub-Helfer prüft
damit die zentrale Zuordnung vor der Registrierung und bestätigt den gespeicherten
Mitgliedsnamen und die Fleet-Farbe danach als `workerIdentity` in seiner Antwort.

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

Ein automatisch registrierter Worker hat Rolle `member` und `macWorker: true`.
Der Inhaber kann die Rolle unabhängig vom MacWorker-Häkchen ändern; die bestehende
Gerätebindung und der Token bleiben erhalten. Nur mit aktiviertem MacWorker darf sein Token seine
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
