# Terminal-Zugriff und Worker-Wartung

Der Wartungszugang läuft als eigener LaunchAgent `de.rs.max-monitor.remote`.
Er verwendet den bereits freigeschalteten SSH-Weg zum RS Hub und einen Reverse-
Tunnel von `127.0.0.1:23000–23999` auf dem Hub zur macOS-Fernanmeldung des Macs.
Die Ports sind nur auf dem Hub erreichbar. Es wird kein neuer öffentlicher Port
und kein HTTP-Endpunkt zum Ausführen von Befehlen eingerichtet.

Der Wartungs-Mac hält einen eigenen Ed25519-Schlüssel. Auf dem Ziel-Mac gilt
dieser ausschließlich für Verbindungen vom lokalen Tunnel-Endpunkt. Andere
SSH-Schlüssel bleiben erhalten. Der Hub speichert die Mac-Hostschlüssel und
Benutzernamen; veränderte Identitäten werden abgewiesen. Der private
Wartungsschlüssel und der Max-Monitor-Inhabertoken werden nicht auf andere Macs
kopiert. Der Tunnel verwendet den schon vorhandenen Worker-Hub-Schlüssel samt
dessen bestehenden Berechtigungen; er ändert die Hub-SSH-Zugangsrechte nicht.

Bei der Installation wird die bereits vertraute öffentliche Hub-Prüfdatei nach
`~/.local/share/max-monitor-remote/hub_known_hosts` kopiert. Der eigenständige
SSH-Dienst benötigt dadurch keinen Zugriff auf den geschützten Documents-Ordner
des Workers. Die strikte Hostschlüsselprüfung bleibt aktiv.

## Einmalige Freigabe auf jedem Ziel-Mac

Als normaler angemeldeter Worker-Benutzer unter **Systemeinstellungen → Allgemein
→ Teilen → Entfernte Anmeldung** einschalten, diesen Benutzer zulassen und für
Zugriff auf geschützte Dateien **Vollständigen Festplattenzugriff für entfernte
Benutzer erlauben** auswählen. Die Installation aktiviert diese macOS-Rechte
nicht selbst. Admin-Befehle über `sudo` benötigen weiterhin die normale
macOS-Authentifizierung; für die Wartung des eigenen Worker-LaunchAgents reicht
der angemeldete Benutzer.

Danach `scripts/setup-worker-remote.sh` ausführen. Das Skript findet die aktive
Installation aus der Worker-LaunchAgent-Datei, auch bei einem Produktions-Checkout
unter `~/.local/share/ai-newsletter-production`. Es lädt seine Hilfsdateien über
den bereits geprüften Hub-SSH-Zugang, registriert die Mac-Identität und startet
den separaten Wartungstunnel. Alternativ `MAX_MONITOR_WORKER_ROOT` vorgeben.

Der Tunnel wird alle 15 Sekunden auf Verbindungsabbrüche geprüft und nach einem
Abbruch mit 30 Sekunden Abstand neu gestartet. Der Newsletter-Dienst wird dabei
weder gestoppt noch neu gestartet. Ein voller Aufgaben-Pool oder ein Claude-Limit
beeinträchtigt den Wartungszugang nicht. Der LaunchAgent startet nach der
Benutzeranmeldung; ein gesperrter FileVault-Start vor der Anmeldung ist damit
nicht abgedeckt.

## Hub-Vorbereitung und Wartungs-Mac

Die benötigten Skripte sind im regulären Hub-Installer enthalten. Einmal auf dem
Wartungs-Mac einen privaten Schlüssel erzeugen, ohne einen bestehenden Schlüssel
zu überschreiben:

```bash
ssh-keygen -t ed25519 -f "$HOME/.ssh/max_monitor_remote_ed25519"
```

Nur den öffentlichen Teil auf dem Hub in
`/etc/max-monitor/remote-operator.pub` als reguläre Datei ablegen. Keine bestehende
Freigabe ungeprüft ersetzen. Der Hub-Helfer liest den vorhandenen privaten
Enrollment-Konfigurationsstand und prüft die Worker-Zuordnung. Deaktivierte
MacWorker behalten ihren Wartungszugang. Nicht registrierte oder mehrdeutige
Worker werden abgewiesen. Ein neuer Registereintrag bestätigt noch keinen
funktionierenden Fernzugriff.

Vom Wartungs-Mac aus:

```bash
node scripts/worker-remote.mjs check macworker-5-schwarz
node scripts/worker-remote.mjs connect macworker-5-schwarz
```

`check` prüft die gesamte SSH-Verbindung, den gespeicherten Hostschlüssel und den
erwarteten Mac-Benutzer. Erst `verified: true` ist ein bestätigter Terminal-Zugang.
Danach den Zugriff auf den aktiven Worker-Code, die Konfiguration und die
konfigurierte Zustandsdatenbank mit einem echten Fernbefehl prüfen. `EPERM` oder
„Operation not permitted“ im Documents-Ordner bedeutet, dass dieser Dateizugriff
noch nicht freigegeben ist; eine erfolgreiche SSH-Anmeldung beweist ihn nicht.
`connect` öffnet das Terminal. `--identity-file` erlaubt einen anderen eigenen
privaten Wartungsschlüssel; `--worker-root` bestimmt die lokale Hub-Konfiguration.
Ein Befehl kann ausdrücklich nach `--` übergeben werden, beispielsweise:

```bash
node scripts/worker-remote.mjs connect macworker-5-schwarz -- 'launchctl print gui/$(id -u)/de.ruegamer-steiner.ai-newsletter'
```

Der produktive Worker-Pfad ist aus der LaunchAgent-Datei zu lesen. Nie blind in
einem Entwicklungs-Checkout aktualisieren. Vor einem Neustart offene Aufgaben,
STOP-Zustand, letzte Abfrage, Kontingent, lokale Änderungen und die tatsächlich
geladene Revision prüfen. Ein laufender Prozess allein beweist keinen gesunden
Worker; nach einer Reparatur eine neue Aufgabenabfrage und die gewünschte
Auftragsannahme bestätigen. Vier reservierte, wartende oder laufende Aufgaben
pro Mac bleiben die verbindliche Grenze.

## Rückbau

Auf dem Ziel-Mac als derselbe Benutzer:

```bash
node "$HOME/.local/share/max-monitor-remote/tool/scripts/worker-remote.mjs" uninstall
```

Das beendet nur den Wartungstunnel und entfernt nur dessen Schlüsselzeile und
LaunchAgent. Andere Schlüssel, macOS-Fernanmeldung und Newsletter-Prozesse bleiben
erhalten. Der private Hub-Registereintrag kann anschließend vom Inhaber entfernt
werden; erst nach beendetem Tunnel einen Port neu vergeben. Eine Schlüsselrotation
muss auf jedem Ziel-Mac durch erneute Installation umgesetzt werden. Das Ersetzen
der öffentlichen Datei auf dem Hub widerruft bereits eingerichtete Macs nicht.

## Verifizierter Diagnose-Stand vom 12.10.2026, 19:57 Uhr

Haupt-Mac (`macbook-till-main`) und Mac 5 (`macworker-5-schwarz`, Benutzer `claude3`)
sind über den neuen SSH-Weg erreichbar. Auf beiden wurden Worker-Code,
Konfiguration und die konfigurierte SQLite-Datenbank per Fernbefehl gelesen.
Auf Mac 5 wurden außerdem Schreiben, Lesen und Entfernen einer privaten
temporären Prüfdatei im Zustandsverzeichnis sowie die Schreibberechtigungen
des bestehenden Codes, Profils und der Datenbank bestätigt.

Mac 5 meldet vier laufende Aufgaben, aktive Max-Monitor-Freigabe und keine
STOP-Datei. Der neue Poll um 19:57:08 Uhr war erfolgreich. Die Annahmepause
bei vier belegten Plätzen entspricht der verbindlichen Kapazitätsgrenze.
Automatisches Wiederverbinden des Wartungstunnels wurde auf beiden Macs
getestet. Die vier anderen Macs brauchen noch die lokale Einrichtung.

Frühere Fleet-Beobachtung um 19:27 Uhr:

Die Live-Fleet meldete für `macworker-5-schwarz`, `macbook-till-main` und
`macbook-von-till-main-2` je vier laufende Aufgaben. Eine zusätzliche Annahme ist
bei vier belegten Plätzen absichtlich gesperrt. `macbook-1` meldete ein verbrauchtes
Claude-Fünf-Stunden-Kontingent bis 20:00 Uhr. Die allgemeine Anzeige „Annahme
pausiert“ unterscheidet diese Gründe noch nicht ausreichend.

Der unabhängige Beobachter behandelt eine mehr als drei Minuten alte Aufgaben-
abfrage außerdem als ungeprüft. Wartungsberichte sagten teilweise lediglich
„Dienst läuft“, obwohl die letzte Abfrage älter war. Ohne lokale Logs ist damit
kein tatsächlicher Hänger bewiesen. Der neue Zugang schafft die Möglichkeit,
dies unabhängig vom Newsletter-Prozess zu prüfen; er hebt weder Kontingente noch
die Vier-Aufgaben-Grenze auf.

Apple beschreibt die erforderlichen Einstellungen in der
[Anleitung zur Fernanmeldung](https://support.apple.com/de-de/guide/mac-help/mchlp1066/mac).
