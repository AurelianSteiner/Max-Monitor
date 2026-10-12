# Worker-Fernzugriff: Übergabe vom 12.10.2026

## Auftrag

Till beauftragt eine dauerhafte Lösung für die erneut als pausiert angezeigte
Auftragsannahme und echten Fernzugriff auf die Macs. Er hat den Umfang auf
Terminal und Worker-Reparatur festgelegt. Bildschirmzugriff gehört nicht dazu.
Till hat die macOS-Fernanmeldung auf dem Haupt-Mac freigegeben und dies bestätigt.
Auch Mac 5 hat die lokale Einrichtung ausgeführt und die korrigierte Installation
erneut geladen.
Um 20:07 Uhr hat Till auch Mac 1, Mac 2 und Mac 4 (Newsletter Mac) als eingerichtet gemeldet.
Till stellte danach ausdrücklich klar: Mac 4 ist `newsletter-mac-141b2976`,
Benutzer `codex1`, macOS-Rechnername „MacBook Air von Codex“.
Den persönlich genutzten `macbook-von-till-main-2` nimmt er ausdrücklich vom
Fernzugriff aus. Auf diesem Mac keine Einrichtung verlangen oder ausführen.

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
  Nach Tills Zusatzfreigabe wurde um 19:53 Uhr auch der echte Zugriff auf
  Worker-Code, Konfiguration und die konfigurierte SQLite-Datenbank unter
  `/Users/claude3/Documents/AI Newsletter Creation` erfolgreich bestätigt.
  Im Zustandsverzeichnis wurde eine temporäre private Prüfdatei geschrieben,
  gelesen und vollständig entfernt. Code, Konfiguration und Datenbank haben
  Schreibberechtigung. Revision `5f983cf`, keine lokalen Git-Änderungen.
- Auch auf Mac 5 wurde ausschließlich der Tunnel-Prozess beendet. launchd
  verband automatisch neu (PID 7417 → 11075), danach bestand der vollständige
  SSH-Test erneut. Der Newsletter-Worker blieb PID 10102. Ein erneuter echter
  Dateitest um 19:51 Uhr ergab vor der Zusatzfreigabe noch `EPERM` für alle drei
  Worker-Pfade.
- Der zuerst scheiternde Mac-5-Tunnel verwendete eine Hub-Prüfdatei im geschützten
  Documents-Ordner. Die korrigierte Installation kopiert die bereits vertrauten
  öffentlichen Pins in das eigene Wartungsverzeichnis. Die strikte SSH-Prüfung
  bleibt aktiv. Die Korrektur liegt bereits auf dem Hub; der Haupt-Mac wurde
  damit erneut installiert und die vollständige Verbindung erneut bestätigt.
- 134 Skript-Tests und 66 Relay-Tests bestanden. Nach dem ergänzten Test für
  macOS-Hostschlüssel und den unabhängigen Prüfdateipfad bestanden alle 16
  Fernzugriffstests plus 11 Hub-Installer-Tests. Bash-Syntaxprüfung und
  `git diff --check` bestanden.
- Um 20:07 Uhr bestätigten echte SSH-Checks und Fernbefehle auch `macbook-1`
  als `tuck2` (Port 23003) und `newsletter-mac-141b2976` als `codex1` (Port 23002).
  Code, Konfiguration und die jeweilige konfigurierte SQLite-Datei wurden gelesen.
  Eine private temporäre Datei im Zustandsverzeichnis wurde jeweils geschrieben,
  gelesen und entfernt; Code, Profil und Datenbank haben Schreibberechtigung.
  Beide Wartungs-LaunchAgents und Newsletter-Dienste liefen, keine STOP-Dateien,
  Max-Monitor-Freigabe aktiv. Keine lokalen Git-Änderungen: Mac 1 `e14f310`,
  Mac 4 (Newsletter Mac) `96f7785` zum Zeitpunkt der Prüfung.

Die Runtime-Erweiterung änderte keine Relay-/Queue-Dienste, Mitglieder,
Inhabertokens oder vorhandene SSH-Zugangsrechte. Vorhandene Dateien wurden
unter `/var/backups/max-monitor/remote-access-20261012T173611Z` gesichert.
Die Client-Hilfsdatei `setup-mac-monitor.mjs` war vorher nicht im Hub-Bundle;
sie ist jetzt auch im regulären Installer enthalten.
Der Code ist auf `codex/worker-remote-access` veröffentlicht; der bestehende
Entwurfs-PR ist https://github.com/AurelianSteiner/Max-Monitor/pull/44.

## Mac-2-Registrierung behoben und Auftrag abgeschlossen

Der erste Mac-2-Versuch scheiterte beim Hub-Lookup; Till meldete
`ssh fehlgeschlagen (Exit 1)`.
Die Live-Gegenprüfung des Worker-Control-Helfers ergab für `macbook-2` ohne UUID
`unregistered`, mit `052ae401-0602-4a39-960e-eeeecd8b6cd4` dagegen `enabled`.
Die native Gerätezeile erhält ihre Worker-ID nur aus Telemetrie; diese darf
keine Identität für die Aufnahmefreigabe erteilen.

Der Installer liest jetzt denselben vorhandenen `monitor-device-id`-Cache neben
`config.paths.state_db` wie der produktive Worker. Der Hub bindet diese UUID
eindeutig an den Wartungszugang und nutzt sie bei jeder erneuten Freigabeprüfung.
Eine andere UUID oder die Wiederverwendung für einen anderen Zugang scheitert.
Bestehende Einträge ohne UUID bleiben kompatibel. Die drei aktualisierten Helfer
wurden um 20:20 Uhr ohne Dienstneustart deployed; Sicherung unter
`/var/backups/max-monitor/remote-access-device-binding-20261012T182005Z`.
Nach dem Deployment bestätigten vier erneute `check`-Aufrufe den SSH-Zugang
zu Till Main, Mac 1, Mac 4 und Mac 5 jeweils mit dem erwarteten Benutzer.
142 Skript-Tests sowie 3 gezielte Worker-Control-Tests bestanden, darunter 22
Fernzugriffstests einschließlich alter nativer Gerätebindung und Identitätskonflikten.
Till bestätigte den erneuten Installer-Lauf. Um 20:37 Uhr bestanden der echte
SSH-Check als `probetag2` und die vollständige Dateidiagnose auf `macbook-2`.
Port 23004, UUID `052ae401-0602-4a39-960e-eeeecd8b6cd4`. Root
`/Users/probetag2/Documents/AI Newsletter Creation`, Revision `20fc097`, keine
lokalen Git-Änderungen. Worker-Code, Profil und SQLite lesbar und mit
Schreibberechtigung; private temporäre Datei geschrieben, gelesen und entfernt.

Anschließend wurde ausschließlich der Wartungstunnel beendet. Um 20:39 Uhr
bestanden SSH und Dateitest erneut: Tunnel PID 67792 → 68293, Newsletter-Worker
unverändert PID 45796. Der frische Poll um 20:38:13 Uhr war erfolgreich
(`ok: true`, 67 Einträge), vier laufende Aufgaben, Freigabe aktiv, keine
STOP-Datei. Die Annahmepause entspricht der vollen Vier-Plätze-Kapazität.
Alle fünf beauftragten Macs sind damit tatsächlich für Terminal und
Worker-Dateiwartung geprüft. Für diese Einrichtung ist kein Nutzerschritt offen.
Alle GitHub-Checks des Code-Stands `30a9463` bestanden ebenfalls.
Keine bloße Registrierung oder `installed: true` als Zugriffserfolg melden:
jeden Mac mit `worker-remote.mjs check <exakte-worker-id>` und einem echten
Dateibefehl prüfen. `macbook-von-till-main-2` bleibt ausdrücklich ausgenommen.

Haupt-Mac, Mac 1, Mac 2, Mac 4 (Newsletter Mac) und Mac 5 sind für Terminal-Wartung einschließlich
Worker-Dateizugriff verifiziert. Der Fernzugriff verwendet die Rechte des jeweiligen Worker-Benutzers;
administrative macOS-Aufgaben benötigen weiterhin dessen normale sudo-Freigabe.

Die allgemeine Monitor-Anzeige „Annahme pausiert“ wurde in diesem Auftrag
nicht visuell geändert. Der neue Zugang ermöglicht die lokale Diagnose; eine
präzisere Anzeige der tatsächlichen Sperrgründe bleibt eine eigene UI-Änderung
mit den geltenden Skill- und Browserprüfungen.

## Erneute Live-Prüfung von Mac 4, 20:21 Uhr

Mac 4 (`newsletter-mac-141b2976`, `codex1`) wurde um 20:21:55 Uhr nochmals über
SSH und den echten Dateidiagnose-Befehl geprüft: Code, Konfiguration und SQLite
lesbar und mit Schreibberechtigung; private temporäre Datei geschrieben, gelesen
und entfernt. Worker PID 82271, Tunnel PID 96170, Revision `96f7785`, keine lokalen
Git-Änderungen. Der neue Poll um 20:21:47 Uhr war erfolgreich (`ok: true`, 68
Einträge), Freigabe aktiv, keine STOP-Datei. Drei laufende und eine wartende
Aufgabe belegen alle vier Plätze; die Annahmepause ist damit korrekt.

## Live-Diagnose, 20:08 Uhr

Mac 1 belegt vier laufende Plätze. Mac 4 (Newsletter Mac) hat lokal drei laufende und
einen wartenden Lauf; damit ebenfalls vier belegte Plätze. Beide letzten Polls
waren aktuell (20:07:34 bzw. 20:07:24 Uhr), meldeten jedoch einen während der
Abfrage geänderten ClickUp-Status. Einen aktuellen erfolglosen Poll nicht als
erfolgreiche vollständige Abfrage darstellen. Keine zusätzlichen Testaufgaben
bei voller Kapazität starten.

Die Live-Fleet um 20:07:54 Uhr meldete alle sechs Worker online. Mac 2 hatte drei
sichtbare aktive Läufe, einen aktuellen Poll und `acceptingTasks: true`; seine
fehlende Wartungsregistrierung ist von der laufenden Produktion getrennt.

Vorherige lokale Diagnose auf Mac 5 um 19:57 Uhr:

Der echte lokale Datenbanktest bestätigte eine erfolgreiche neue Aufgabenabfrage
um 19:57:08 Uhr (`ok: true`, 73 Einträge). `worker_control` wurde um 19:57:35 Uhr
erneut als aktiv geprüft; vier laufende Läufe, keine STOP-Datei. Die Annahmepause
bei vier belegten Plätzen ist beabsichtigt. Der zwischenzeitliche ClickUp-
Statuskonflikt wurde im nächsten vollständigen Poll wieder erfolgreich gelesen.
Keine zusätzliche Testaufgabe starten, solange alle vier Plätze belegt sind.

Die Logs erklären die weiteren Worker-Neustarts durch reguläre automatische
Codeupdates: um 19:53 Uhr wurde `5f983cf` auf `20fc097` aktualisiert und die
vier aktiven Läufe übernommen. Worker PID 14178 und Wartungstunnel PID 11075
liefen um 19:57:43 Uhr. Der Wartungstunnel blieb über das Worker-Update hinweg
erreichbar; kein Eingriff in diesen Update-Prozess war nötig.

Vorherige Fleet-Beobachtung um 19:51 Uhr:

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

## Künftige Worker-Diagnose

Die Fernzugriff-Einrichtung ist abgeschlossen. Falls ein Mac später trotz freier
Plätze und nutzbarem Claude pausiert, über den Zugang den aktiven Produktionspfad,
STOP-Zustand, `worker_control`, `monitor_admission`, `last_poll`, reservierte
Plätze und lokale Logs prüfen. Nur einen nachgewiesenen Defekt reparieren;
laufende Aufgaben erhalten und danach neuen Poll und Auftragsannahme bestätigen.
Till Main 2 bleibt von diesem Wartungszugang ausgenommen.

Der Entwicklungs-Checkout `Documents/AI Newsletter Creation` enthält umfangreiche
fremde Änderungen; nicht zurücksetzen oder dort beiläufig Worker-Code ändern.
Die lokale Produktion läuft aus `~/.local/share/ai-newsletter-production`, nutzt
aber laut geladenem Profil die Zustandsdatenbank im Entwicklungsverzeichnis.
Die genaue Datei steht in `config.paths.state_db`; keine Pfade raten.

Einrichtung und Rückbau stehen in [worker-remote-access.md](worker-remote-access.md).


## Persönlicher Fernzugriff für alle Team-Mitglieder, abgeschlossen 21:29 Uhr

Till beauftragt anschließend: Alle Personen mit Max-Monitor-Zugang sollen die
Macs warten können. Auf dem Hub und allen fünf eingerichteten Ziel-Macs ist
jetzt eine SSH-Zertifikatsfreigabe installiert. Bestehende und künftige aktive
Team-Mitglieder aller Rollen nutzen ihren eigenen Max-Monitor-Zugangscode;
`macWorker` und Queue-Rechte bleiben unabhängig. Till Main 2 bleibt als Ziel
entsprechend Tills vorheriger Ausnahme ausgeschlossen, sein Team-Zugang kann
aber auf die anderen fünf Macs zugreifen.

`team-server/remote-access.js` signiert nach frischer persönlicher Authentifizierung
nur einen öffentlichen Schlüssel für genau den angefragten registrierten Mac.
Die 90 Sekunden gültigen Anmeldezertifikate tragen Mitgliedskennung und exakte
Bastion-/Mac-Principals. Der öffentliche Python-Client nutzt temporäre eigene
Schlüssel und gepinnte Hostschlüssel; private Operator- und Root-Schlüssel
werden nicht verteilt. Der Hub-Benutzer `max-monitor-access` erlaubt ausschließlich
die fünf Loopback-Zielports; er besitzt keine Hub-Shell. Lokale CA-Freigaben auf
den Ziel-Macs erlauben Terminal und PTY, keine Weiterleitungen. Die Installer
übernehmen diese Freigabe künftig und entfernen nur die eigenen Zeilen beim
Uninstall. Nutzung und Rückbau stehen in `docs/team-remote-access.md`.

Alle neun vorhandenen Team-Zugänge erhielten live persönlich gebundene
Zertifikate. Mit den persönlichen Zugängen von Vale und Reli bestanden echte
SSH-Anmeldungen und `id -un` jeweils auf allen fünf Macs. Ein einmaliger
Banner-Timeout von Reli auf Mac 4 bestand nach gezielter Wiederholung. Die Tests
liefen von Till Main aus; die physischen Rechner von Vale und Reli wurden dabei
nicht bedient. Der veröffentlichte Client entspricht bytegenau der geprüften
lokalen Quelle. Keine Newsletter-Worker wurden für die CA-Freigaben neu gestartet.

Unbekannte Token werden live mit 401, der private Mac als Ziel mit 404 abgewiesen.
Hub-Shell, unzulässige Ports und Reverse-Forwarding wurden live gesperrt; alle
Rollen einschließlich Gast sowie entfernter Mitgliedszugang sind im HTTP-Test
abgedeckt. 145 Skript-Tests, 70 Relay-Tests und drei Python-Client-Tests bestanden.

Der Hub verwarf zuvor echte SSH-Verbindungen wegen `MaxStartups 10:30:100`.
Die neue Datei `/etc/ssh/sshd_config.d/00-max-monitor-capacity.conf` setzt
`MaxStartups 50:30:100`; effektive Konfiguration und laufender Listener bestätigen
das. Nach dem Reload keine weiteren MaxStartups-Abweisungen im geprüften
Journalfenster. Bestehende Tunnel bleiben erhalten. Sicherungen:
`/var/backups/max-monitor/team-remote-20261012T185242Z` (Runtime/SSH) und
`/var/backups/max-monitor/team-ssh-capacity-20261012T190838Z` (Kapazität).
Die Live-Hub-Installer-Datei besaß eigene Änderungen; nur ihre Bundle-Dateiliste
wurde ergänzt, der übrige Inhalt erhalten.
