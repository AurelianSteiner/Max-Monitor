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

## Zugang für alle Team-Mitglieder

Die vier eingerichteten Worker-Macs akzeptieren zusätzlich persönliche Max-Monitor-
Team-Zugänge. Inhaber, Admin, Mitglied und Gast erhalten nach frischer
Anmeldung kurzlebige SSH-Zertifikate. Till Main und Till Main 2 sind als Ziele
ausgenommen.
Befehl, Freigabe und Widerruf stehen in [team-remote-access.md](team-remote-access.md).
Die folgenden Operator-Befehle bleiben für Einrichtung und Wartung gültig.

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
Worker werden abgewiesen. Ältere manuell verbundene Apps werden über ihre bereits
vorhandene zufällige Gerätekennung zugeordnet. Der Installer liest dafür nur den
bestehenden Cache `monitor-device-id` neben der konfigurierten Zustandsdatenbank.
Der Hub speichert diese Kennung mit dem Wartungszugang und prüft sie bei jedem
Lookup erneut gegen die aktuelle Freigabe. Anzeigenamen erteilen keine Rechte;
eine andere oder doppelte Gerätekennung wird abgewiesen.
Ein neuer Registereintrag bestätigt noch keinen
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

## Verifizierter Diagnose-Stand vom 12.10.2026, 20:39 Uhr

Alle fünf gewünschten Macs sind für SSH und echten Worker-Dateizugriff
verifiziert. Till Main 2 ist auf Nutzerwunsch ausgenommen:

| Mac | Worker | SSH-Benutzer | Hub-Loopback-Port | Status |
| --- | --- | --- | --- | --- |
| Till Main | `macbook-till-main` | `tillticktucktim` | 23000 | Terminal und Worker-Dateien geprüft |
| Mac 5 schwarz | `macworker-5-schwarz` | `claude3` | 23001 | Terminal, Worker-Dateien und Schreiben geprüft |
| Mac 4 / Newsletter Mac | `newsletter-mac-141b2976` | `codex1` | 23002 | Terminal, Worker-Dateien und Schreiben geprüft |
| Mac 1 | `macbook-1` | `tuck2` | 23003 | Terminal, Worker-Dateien und Schreiben geprüft |
| Mac 2 | `macbook-2` | `probetag2` | 23004 | Terminal, Worker-Dateien und Schreiben geprüft |

Der vorherige Mac-2-Installer-Fehler
`ssh fehlgeschlagen (Exit 1)` wurde eingegrenzt: Die ältere native App wird nur
über ihre vorhandene Gerätekennung erkannt. Die Gegenprüfung auf dem Hub gab
ohne diese Kennung `unregistered`, mit der exakten Kennung `enabled` zurück.
Die korrigierten Helfer liegen seit 20:20 Uhr auf dem Hub. Nach dem erneuten
lokalen Installer-Lauf wurden SSH, Code, Profil, SQLite und Schreiben/Lesen/
Entfernen einer privaten Prüfdatei auf Mac 2 um 20:37 Uhr bestätigt.
Die vorhandene Gerätekennung ist eindeutig im Wartungsprofil gespeichert.
`macbook-von-till-main-2` ist auf ausdrücklichen Wunsch des Nutzers von diesem
Fernzugriff ausgenommen. Das ist keine Deaktivierung seines Workers.

Mac 2 wurde nach bewusstem Beenden ausschließlich des Wartungstunnels um
20:39 Uhr erneut erfolgreich geprüft: Tunnel PID 67792 → 68293, Worker PID
45796 blieb unverändert. Der neue Poll um 20:38:13 Uhr war erfolgreich; vier
laufende Aufgaben, aktive Freigabe und keine STOP-Datei. Auch dort ist die
Annahmepause durch den vollen Aufgaben-Pool beabsichtigt.

Lokale Diagnose um 20:07 Uhr: Mac 1 hatte vier laufende Aufgaben. Mac 4
(Newsletter Mac, macOS-Rechnername „MacBook Air von Codex“) hatte drei laufende
und eine wartende Aufgabe. Beide Pools waren damit voll. Ihre damaligen Polls meldeten
einen während der Abfrage geänderten ClickUp-Status; die SSH-/Dateiprüfung ist
unabhängig davon erfolgreich. Mac 2 wurde von der Live-Fleet online mit drei
aktiven Aufgaben und erlaubter Annahme gemeldet.

Erneute echte Dateiprüfung auf Mac 4 um 20:21:55 Uhr: Code, Konfiguration und
SQLite zugänglich, Schreibtest erfolgreich, beide Dienste laufen. Der neue Poll
um 20:21:47 Uhr war erfolgreich. Weiterhin drei laufende plus eine wartende
Aufgabe, aktive Freigabe und keine STOP-Datei; die vier Plätze sind belegt.

Vorherige lokale Diagnose auf Mac 5 um 19:57 Uhr:

Haupt-Mac (`macbook-till-main`) und Mac 5 (`macworker-5-schwarz`, Benutzer `claude3`)
sind über den neuen SSH-Weg erreichbar. Auf beiden wurden Worker-Code,
Konfiguration und die konfigurierte SQLite-Datenbank per Fernbefehl gelesen.
Auf Mac 5 wurden außerdem Schreiben, Lesen und Entfernen einer privaten
temporären Prüfdatei im Zustandsverzeichnis sowie die Schreibberechtigungen
des bestehenden Codes, Profils und der Datenbank bestätigt.

Mac 5 meldet vier laufende Aufgaben, aktive Max-Monitor-Freigabe und keine
STOP-Datei. Der neue Poll um 19:57:08 Uhr war erfolgreich. Die Annahmepause
bei vier belegten Plätzen entspricht der verbindlichen Kapazitätsgrenze.
Automatisches Wiederverbinden des Wartungstunnels wurde auf Haupt-Mac, Mac 5
und Mac 2 getestet.

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
