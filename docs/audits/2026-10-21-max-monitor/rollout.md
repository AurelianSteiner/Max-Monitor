# Live-Ausrollung der technischen Auditkorrekturen

Max Monitor 2.16.2 wurde auf allen neun berichtenden Worker-Macs installiert und nach dem Austausch authentifiziert bestätigt. Die 19 technischen Auditpunkte und die beiden ergänzenden Vertragskorrekturen sind veröffentlicht. F11 bleibt in [Offene Entscheidungen](open-decisions.md) getrennt offen; `TeamAutoReporter` wurde nicht geändert. Auch die Verbindungsprüfung von Orange ist abgeschlossen. Das anschließende Tracking-Update auf 2.16.3 und die erfolgreiche Kontingentanmeldung sind in [Kontingentanmeldung und Tracking-Update](tracking-closeout.md) mit den aktuellen Live-Belegen dokumentiert.

## Ausgelieferter Stand

- Native App dieses Audit-Rollouts: Version 2.16.2, Bauquellen `2a9150c2a346d460664a9e7a944e7e2c5b0d4d2c`. Die bereits live verwendete dauerhafte Zugangsdaten-Speicherung aus 2.16/2.16.1 ist übernommen. Der spätere Tracking-Stand `4ff3340` ergänzt native gzip-Übertragung und gehört zum nachfolgenden Rollout.
- Relay und Queue: 51 Manifestdateien mit tatsächlichem Hash-Readback. Beim abschließenden Abgleich ist Runtime `2a3090fa59a190ae26157595606bba9fbe7051c9` bestätigt; dieser Stand enthält zusätzlich die parallel ergänzte Trennung von Gerätebericht und erfolgreicher Aufgabenabfrage.
- [Öffentliches Release 2.16.2](https://github.com/AurelianSteiner/Max-Monitor/releases/tag/v2.16.2), Worker-Paket und kanonischer Sparkle-Feed sind veröffentlicht. Beide Downloads wurden ohne Anmeldung erneut geladen und gehasht. Die Feed-Signatur wurde unabhängig mit dem ursprünglichen öffentlichen Ed25519-Schlüssel gegen das öffentliche DMG geprüft. Das gemountete DMG, beide Architekturen und die strenge Bundle-Signatur sind geprüft.

## Erhalt der laufenden Arbeit

Beim jeweiligen App-Austausch blieb der Newsletter-Dienstprozess auf jedem Mac erhalten. Auf Gelb, Grün und Lila wurden unmittelbar vor und nach dem Austausch dieselben insgesamt 15 Laufkennungen und Prozesskennungen bestätigt; die sechs übrigen Macs hatten dabei keine aktiven Aufträge. Der Installer hat ausschließlich die Monitor-App ersetzt. Rückfallkopien der bisherigen Apps liegen geschützt auf den jeweiligen Macs.

Alle neun Geräte behalten ihre Gerätekennung und ihre bisherige Signaturart beziehungsweise ihr bisheriges Zertifikat. Pro Mac läuft genau eine Monitor-App. Der anschließende reguläre automatische Abgleich bestätigt auf allen neun Macs `preferences_preserved`, erhält den GUI-Prozess und meldet Erfolg. Die tatsächlichen Startdiagnosen bestätigen den lokalen Tresor, lesbare gespeicherte Daten und jeweils **null Alt-Schlüsselbundlesezugriffe**. Entsperren des Login-Schlüsselbunds war für diese bereits migrierten Installationen nicht erforderlich.

## Prüfungen

| Prüfung | Bestätigtes Ergebnis |
| --- | --- |
| Node 22.22.2, vollständige Suite | 524 Tests bestanden |
| Node 22.22.2, erneute vollständige Suite auf `ea2aed2` nach Oranges Rückkehr | 526 Tests bestanden, keine Fehler oder übersprungenen Tests |
| SwiftPM mit erhaltener dauerhafter Speicherung | 208 Tests bestanden |
| Python | 131 lokal bestanden; zusätzlich alle sechs echten Linux-Mount-Fälle in CI bestanden |
| Produktionsmethoden für native Auditkorrekturen | Alle fünf Szenariogruppen bestanden |
| Tatsächlicher Zugangsdaten-Speicher | 70 Prüfungen bestanden; keine echten Schlüsselbundzugriffe im Test |
| Getrennte Prozesse und unterschiedlich signierte Test-Binaries | Einrichtung, Neustart, Tokenrotation und gelöschte Einträge erhalten |
| Vollständige GitHub-CI | Alle sechs Jobs grün, einschließlich macOS-App-Bauten und Linux-Mounts |
| Echte Live-Oberfläche in Chrome | Macs, laufende Queue, Planung und Verbrauch bei 1440×900, 1024×768 und 390×844 geprüft; keine Seitenfehler oder horizontaler Überlauf |
| Öffentliche Webassets | Alle sechs JavaScript-/CSS-Dateien stimmen per SHA-256 mit der Quelle überein |
| Laufende Dienste und Queue | Relay/Queue aktiv; reguläre neue vollständige Queue-Snapshots ohne Quellenfehler |

CI-Belege: [Downloadkorrektur und Gesamtprüfung](https://github.com/AurelianSteiner/Max-Monitor/actions/runs/39636748911), [abschließend integrierter Hauptstand](https://github.com/AurelianSteiner/Max-Monitor/actions/runs/39638414161).

## Beim Rollout zusätzlich behoben

Der Runtime-Installer akzeptiert jetzt auch das gemeinsame Manifest selbst und legt dessen bisher fehlendes Zielverzeichnis an. Eine vollständige Installation aller echten Manifestdateien wird in einer isolierten Ablage geprüft. Der öffentliche Worker-Download verwendet HTTPS ohne GitHub-Anmeldung; HTTPS-Weiterleitungen, Größenlimit, feste Prüfsumme und Bundle-Signatur bleiben verbindlich. Bestehende Ad-hoc-Installationen behalten ihre Signaturart auch bei einem zentral mit Zertifikat signierten Paket. Die Linux-Tests verwenden ein kontrolliertes Kapazitätsangebot; die produktive Speicherreserve bleibt unverändert.

Orange erhielt nach einem langsamen öffentlichen Download dasselbe hashgeprüfte Paket über den bestehenden authentifizierten Wartungszugang. Seine zusätzliche Hub-Verbindungsprüfung wird getrennt vom erfolgreichen App-Rollout dokumentiert.

## Abgeschlossene Verbindungsprüfung: Orange

Die App und der automatische Monitor-Abgleich auf Orange waren mit 2.16.2, erhaltenen Einstellungen und lesbarem lokalem Tresor bestätigt. Seine eigentliche Aufgabenabfrage verzeichnete jedoch wiederholt `Hub-Transport: Zeitüberschreitung`; Geräteberichte allein bestätigen diesen Abruf nicht. Direkte kleine Hub-Aufrufe und HTTPS-Healthchecks funktionierten zwischendurch. Die damalige Diagnose zeigte aktiviertes SSH-Multiplexing.

Die Umstellung auf frische SSH-Verbindungen und das Neuladen ausschließlich dieses unbeschäftigten Workers wurden mit einer erneuten Prüfung auf null aktive, wartende oder pausierte Läufe abgesichert. Die Wartungsverbindung brach während des Schritts ab. Danach war auch der Reverse-SSH-Port nicht erreichbar. Ob Profiländerung und Neuladen vollständig ausgeführt wurden, ist deshalb noch nicht zurückgelesen und wird nicht als bestätigte Reparatur gewertet. Der Benutzer wurde um eine lokale Prüfung von Wachzustand und WLAN gebeten. Laufende Aufträge auf den anderen Macs wurden nicht berührt.

Nach der lokalen Rückmeldung des Benutzers wurden drei voneinander getrennte Wartungsverbindungen erfolgreich geöffnet. Die tatsächliche Worker-Datenbank bestätigt neue Aufgabenabrufe mit `ok: true` um **17:19:44.968, 17:20:24.274 und 17:20:49.529 UTC am 21.10.2026**, jeweils mit 85 gelisteten Aufgaben. Worker-PID 584 und Monitor-PID 1577 blieben zwischen diesen drei Prüfungen gleich; Orange hatte keine aktiven, wartenden oder pausierten Läufe. Ein zusätzlicher Abruf um **17:23:13.796 UTC** war ebenfalls erfolgreich, inzwischen mit 83 Aufgaben und Worker-PID 14889. Für diese Nachprüfung wurden unsererseits ausschließlich Lesezugriffe ausgeführt, weder Profiländerung noch Neustart; die zwischenzeitliche Prozessänderung wird nicht als eigener Eingriff gewertet.

Das tatsächlich geladene Profil verwendet weiterhin `ssh_multiplex: true`; in der lokalen JSON-Datei steht kein eigener Override. Weder die vorgesehene Sicherung noch eine temporäre Datei des früheren Reparaturversuchs sind vorhanden. Die Erholung wird deshalb nicht einer unbestätigten Profiländerung zugeschrieben. Ein endgültiger physischer Grund für den früheren Verbindungsabbruch ist damit nicht belegt.

Der zentrale Abgleich um **17:20:51 UTC** bestätigt neue native Geräteberichte und Worker-Berichte aller neun Macs, aktive Relay-/Queue-Dienste und einen frischen vollständigen Queue-Snapshot ohne Quellenfehler. Alle 51 Manifestdateien der inzwischen separat aktualisierten Runtime `4ff3340c1684cbc3609a1bfac34b4218e1bce087` stimmen mit deren Installationsbeleg überein. Oranges Startdiagnose bestätigt weiterhin App 2.16.2, geöffneten lokalen Tresor und null Alt-Schlüsselbundlesezugriffe.

## Historischer Zwischenstand des Tracking-Rollouts

Der Chat „Tracking komplett prüfen“ ergänzt nach dem Audit-Rollout gzip für native Geräte-/Kontingentmeldungen und bereitet dafür App 2.16.3 vor. Bei Orange hat der automatische Abgleich dieser neuen nativen Quellen einen lokalen Compilerfehler gemeldet: `CredentialStartup.swift:6:1: 'nonisolated' modifier cannot be applied to this declaration`. Das Update wurde zurückgestellt; die installierte und weiterhin berichtende App 2.16.2 blieb erhalten. Die Abnahme des nachfolgenden App-Updates ist damit noch offen.

Oranges zentrale Kontingentmeldung enthält außerdem `Sign-in expired — please sign in again`; Aufgabenabruf und Wartungszugang funktionieren. Die erneute Anmeldung und deren Kontingentprüfung werden im genannten Chat bereits separat bearbeitet. Eine vollständige aktuelle Kontingentmessung wird hier deshalb nicht behauptet. F11 bleibt davon unabhängig offen.

Dieser Zwischenstand ist inzwischen überholt: Alle neun Macs sind auf 2.16.3, die reguläre Monitor-Wartung und die gzip-Übertragung sind bestätigt. Orange hat einen neuen Monitoring-Zugang und erneut erfolgreiche reguläre Kontingentabrufe. Die [nachfolgende Live-Abnahme](tracking-closeout.md) enthält die aktuellen Ergebnisse; F11 bleibt offen.

Die Prüfung schickt keine echten Kundenaufträge durch Schreibtests und versetzt keinen Mac absichtlich in den Ruhezustand. OAuth-Fehler, Kontowechsel, Berechtigungswechsel, konkurrierende Zustände und Schlafschutz-Übergänge sind mit den tatsächlichen Produktionsmethoden und isolierten Systemgrenzen geprüft.

Die maschinenlesbare Zusammenfassung steht in [live-verification.json](live-verification.json). Vollständige technische Rohbelege und Screenshots liegen zusätzlich geschützt im lokalen Task-Artefaktordner.
