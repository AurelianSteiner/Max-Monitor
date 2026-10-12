# Worker-Fernzugriff: Übergabe vom 12.10.2026

## Auftrag

Till beauftragt eine dauerhafte Lösung für die erneut als pausiert angezeigte
Auftragsannahme und echten Fernzugriff auf die Macs. Er hat den Umfang auf
Terminal und Worker-Reparatur festgelegt. Bildschirmzugriff gehört nicht dazu.
Till hat die macOS-Fernanmeldung auf dem Haupt-Mac freigegeben und dies bestätigt.
Auch Mac 5 hat die lokale Einrichtung ausgeführt und die korrigierte Installation
erneut geladen.

## Fertig und live geprüft

- `scripts/worker-remote-hub.mjs`, `scripts/worker-remote.mjs`,
  `scripts/setup-worker-remote.sh` und die benötigte Client-Hilfsdatei liegen auf
  dem bestehenden Hub unter `/opt/max-monitor/scripts/`.
- Die freigegebene öffentliche Operator-Datei liegt auf dem Hub unter
  `/etc/max-monitor/remote-operator.pub`. Der private Wartungsschlüssel bleibt
  auf diesem Mac unter `~/.ssh/max_monitor_remote_ed25519`; nicht ausgeben oder
  auf andere Macs kopieren.
- `macbook-till-main` ist im privaten Register `/etc/max-monitor/remote-access.json`
  als `tillticktucktim`, Loopback-Port 23000, mit geprüftem Hostschlüssel registriert.
- `de.rs.max-monitor.remote` ist als eigener Benutzer-LaunchAgent installiert.
  Die stabilen Client-Hilfsdateien liegen unter
  `~/.local/share/max-monitor-remote/tool/`.
- `check macbook-till-main` hat zweimal die vollständige Verbindung über den
  Hub und den erwarteten Benutzer bestätigt, zuletzt nach bewusstem Beenden
  ausschließlich des Tunnel-Prozesses. launchd verband sich automatisch neu
  (PID 49076 → 52829); der Newsletter-Dienst blieb PID 4392.
- Ein realer Fernbefehl hat die produktive Worker-LaunchAgent-Konfiguration
  über diesen Tunnel ausgelesen. Kein Newsletter-Dienst wurde neu gestartet.
  Nach der Prüfdatei-Korrektur wurden auch Worker-Code, Konfiguration und die
  konfigurierte Zustandsdatenbank über SSH erfolgreich gelesen.
- `check macworker-5-schwarz` bestätigte um 19:48 Uhr die vollständige SSH-Verbindung
  als `claude3` über Port 23001. Worker PID 10102 und Wartungstunnel PID 7417 liefen.
  Der Zugriff auf Worker-Code, Konfiguration und Zustandsverzeichnis unter
  `/Users/claude3/Documents/AI Newsletter Creation` wurde jedoch mit `EPERM`
  abgewiesen. Die Zusatzfreigabe für entfernten Festplattenzugriff wird gerade
  durch Till geprüft; bis zum echten Dateizugriff keine vollständige
  Worker-Reparaturfähigkeit melden.
- Auch auf Mac 5 wurde ausschließlich der Tunnel-Prozess beendet. launchd
  verband automatisch neu (PID 7417 → 11075), danach bestand der vollständige
  SSH-Test erneut. Der Newsletter-Worker blieb PID 10102. Ein erneuter echter
  Dateitest um 19:51 Uhr ergab weiterhin `EPERM` für alle drei Worker-Pfade.
- Der zuerst scheiternde Mac-5-Tunnel verwendete eine Hub-Prüfdatei im geschützten
  Documents-Ordner. Die korrigierte Installation kopiert die bereits vertrauten
  öffentlichen Pins in das eigene Wartungsverzeichnis. Die strikte SSH-Prüfung
  bleibt aktiv. Die Korrektur liegt bereits auf dem Hub; der Haupt-Mac wurde
  damit erneut installiert und die vollständige Verbindung erneut bestätigt.
- 134 Skript-Tests und 66 Relay-Tests bestanden. Nach dem ergänzten Test für
  macOS-Hostschlüssel und den unabhängigen Prüfdateipfad bestanden alle 16
  Fernzugriffstests plus 11 Hub-Installer-Tests. Bash-Syntaxprüfung und
  `git diff --check` bestanden.

Die Runtime-Erweiterung änderte keine Relay-/Queue-Dienste, Mitglieder,
Inhabertokens oder vorhandene SSH-Zugangsrechte. Vorhandene Dateien wurden
unter `/var/backups/max-monitor/remote-access-20261012T173611Z` gesichert.
Die Client-Hilfsdatei `setup-mac-monitor.mjs` war vorher nicht im Hub-Bundle;
sie ist jetzt auch im regulären Installer enthalten.
Der Code ist auf `codex/worker-remote-access` veröffentlicht; der bestehende
Entwurfs-PR ist https://github.com/AurelianSteiner/Max-Monitor/pull/44.

## Noch offen

Die vier anderen Macs sind noch nicht für diesen neuen Terminal-Zugang
registriert. Pro Mac muss der angemeldete Benutzer die macOS-Fernanmeldung
freigeben und den bereitgestellten Setup-Befehl einmal ausführen. Das lässt sich
über den bisher nur lesenden Monitor-Beobachter nicht ausführen. Keine bloße
Registrierung oder `installed: true` als Zugriffserfolg melden: jeden Mac mit
`worker-remote.mjs check <exakte-worker-id>` prüfen.
Auf Mac 5 ist zusätzlich die Dateifreigabe noch zu verifizieren. Danach den
aktiven Konfigurationspfad aus dem LaunchAgent lesen, die Konfiguration laden
und die konfigurierte Datenbank schreibgeschützt auslesen.

Die allgemeine Monitor-Anzeige „Annahme pausiert“ wurde in diesem Auftrag
nicht visuell geändert. Der neue Zugang ermöglicht die lokale Diagnose; eine
präzisere Anzeige der tatsächlichen Sperrgründe bleibt eine eigene UI-Änderung
mit den geltenden Skill- und Browserprüfungen.

## Live-Diagnose, 19:51 Uhr

Mac 5 meldete weiterhin vier laufende Aufgaben mit Fortschritt 90 %, 70 %, 72 %
und 75 %. Der frische Beobachterbericht um 19:50:50 Uhr bestätigt laufende
Bearbeitung; die zuletzt gemeldete vollständige Aufgabenabfrage war 19:46:27 Uhr.
Annahme bei vollem Pool bleibt absichtlich gesperrt. Den älteren Poll und die
aktuelle Bearbeitung getrennt bewerten; kein Neustart allein aufgrund der Anzeige.

Zuvor um 19:38 Uhr:

Alle sechs Macs waren online. Vier laufende Aufgaben wurden jeweils für
`macbook-till-main`, `macbook-von-till-main-2`, `macworker-5-schwarz` und inzwischen
auch `newsletter-mac-141b2976` gemeldet. Die Vier-Aufgaben-Grenze ist verbindlich
und darf nicht gelockert werden. `macbook-1` hatte ein volles Claude-Fünf-Stunden-
Kontingent bis 20:00 Uhr. `macbook-2` hatte zwei sichtbare Läufe; dessen false-
Annahmewert ist ohne lokale Logs noch nicht abschließend erklärt. Der Beobachter
setzt die effektive Annahme bei mehr als drei Minuten altem Poll ebenfalls false.
Aktuelle Heartbeats, Beobachterberichte und vollständige Polls sind getrennt
zu bewerten.

## Nächste Schritte

1. Setup auf den übrigen Macs ausführen und jeden tatsächlichen SSH-Zugang prüfen.
2. Falls ein Mac trotz freier Plätze und nutzbarem Claude pausiert, über den
   neuen Zugang den aktiven Produktionspfad, STOP-Zustand, `worker_control`,
   `monitor_admission`, `last_poll`, reservierte Plätze und lokale Logs lesen.
3. Nur einen nachgewiesenen Defekt reparieren; laufende Aufgaben erhalten und
   anschließend neuen Poll und Auftragsannahme verifizieren.

Der Entwicklungs-Checkout `Documents/AI Newsletter Creation` enthält umfangreiche
fremde Änderungen; nicht zurücksetzen oder dort beiläufig Worker-Code ändern.
Die lokale Produktion läuft aus `~/.local/share/ai-newsletter-production`, nutzt
aber laut geladenem Profil die Zustandsdatenbank im Entwicklungsverzeichnis.
Die genaue Datei steht in `config.paths.state_db`; keine Pfade raten.

Einrichtung und Rückbau stehen in [worker-remote-access.md](worker-remote-access.md).
