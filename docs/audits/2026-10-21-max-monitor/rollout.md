# Live-Ausrollung der technischen Auditkorrekturen

Max Monitor 2.16.2 ist auf allen neun berichtenden Worker-Macs installiert und nach dem Austausch authentifiziert bestätigt. Die 19 technischen Auditpunkte und die beiden ergänzenden Vertragskorrekturen sind veröffentlicht. F11 bleibt in [Offene Entscheidungen](open-decisions.md) getrennt offen; `TeamAutoReporter` wurde nicht geändert. Die abschließende Gesamtfreigabe bleibt wegen der unten beschriebenen Verbindung von Orange offen.

## Ausgelieferter Stand

- Native App: Version 2.16.2, Bauquellen `2a9150c2a346d460664a9e7a944e7e2c5b0d4d2c`. Die nativen Eingaben sind auch im späteren Hauptstand unverändert. Die bereits live verwendete dauerhafte Zugangsdaten-Speicherung aus 2.16/2.16.1 ist übernommen.
- Relay und Queue: 51 Manifestdateien mit tatsächlichem Hash-Readback. Beim abschließenden Abgleich ist Runtime `2a3090fa59a190ae26157595606bba9fbe7051c9` bestätigt; dieser Stand enthält zusätzlich die parallel ergänzte Trennung von Gerätebericht und erfolgreicher Aufgabenabfrage.
- [Öffentliches Release 2.16.2](https://github.com/AurelianSteiner/Max-Monitor/releases/tag/v2.16.2), Worker-Paket und kanonischer Sparkle-Feed sind veröffentlicht. Beide Downloads wurden ohne Anmeldung erneut geladen und gehasht. Die Feed-Signatur wurde unabhängig mit dem ursprünglichen öffentlichen Ed25519-Schlüssel gegen das öffentliche DMG geprüft. Das gemountete DMG, beide Architekturen und die strenge Bundle-Signatur sind geprüft.

## Erhalt der laufenden Arbeit

Beim jeweiligen App-Austausch blieb der Newsletter-Dienstprozess auf jedem Mac erhalten. Auf Gelb, Grün und Lila wurden unmittelbar vor und nach dem Austausch dieselben insgesamt 15 Laufkennungen und Prozesskennungen bestätigt; die sechs übrigen Macs hatten dabei keine aktiven Aufträge. Der Installer hat ausschließlich die Monitor-App ersetzt. Rückfallkopien der bisherigen Apps liegen geschützt auf den jeweiligen Macs.

Alle neun Geräte behalten ihre Gerätekennung und ihre bisherige Signaturart beziehungsweise ihr bisheriges Zertifikat. Pro Mac läuft genau eine Monitor-App. Der anschließende reguläre automatische Abgleich bestätigt auf allen neun Macs `preferences_preserved`, erhält den GUI-Prozess und meldet Erfolg. Die tatsächlichen Startdiagnosen bestätigen den lokalen Tresor, lesbare gespeicherte Daten und jeweils **null Alt-Schlüsselbundlesezugriffe**. Entsperren des Login-Schlüsselbunds war für diese bereits migrierten Installationen nicht erforderlich.

## Prüfungen

| Prüfung | Bestätigtes Ergebnis |
| --- | --- |
| Node 22.22.2, vollständige Suite | 524 Tests bestanden |
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

## Offener betrieblicher Befund: Orange

Die App und der automatische Monitor-Abgleich auf Orange waren mit 2.16.2, erhaltenen Einstellungen und lesbarem lokalem Tresor bestätigt. Seine eigentliche Aufgabenabfrage verzeichnete jedoch wiederholt `Hub-Transport: Zeitüberschreitung`; Geräteberichte allein bestätigen diesen Abruf nicht. Direkte kleine Hub-Aufrufe und HTTPS-Healthchecks funktionierten zwischendurch. Im lokalen Worker-Profil ist entgegen dem aktuellen Standard noch `hub.ssh_multiplex: true` bestätigt.

Die Umstellung auf frische SSH-Verbindungen und das Neuladen ausschließlich dieses unbeschäftigten Workers wurden mit einer erneuten Prüfung auf null aktive, wartende oder pausierte Läufe abgesichert. Die Wartungsverbindung brach während des Schritts ab. Danach war auch der Reverse-SSH-Port nicht erreichbar. Ob Profiländerung und Neuladen vollständig ausgeführt wurden, ist deshalb noch nicht zurückgelesen und wird nicht als bestätigte Reparatur gewertet. Der Benutzer wurde um eine lokale Prüfung von Wachzustand und WLAN gebeten. Laufende Aufträge auf den anderen Macs wurden nicht berührt.

Nach Wiederkehr des Wartungszugangs zuerst Profil, Dienst und tatsächliches Ergebnis des letzten Aufgabenabrufs lesen; keinen weiteren Neustart auf Verdacht auslösen. Erst ein neuer erfolgreicher Abruf und frische zentrale Meldungen schließen diesen Befund.

Die Prüfung schickt keine echten Kundenaufträge durch Schreibtests und versetzt keinen Mac absichtlich in den Ruhezustand. OAuth-Fehler, Kontowechsel, Berechtigungswechsel, konkurrierende Zustände und Schlafschutz-Übergänge sind mit den tatsächlichen Produktionsmethoden und isolierten Systemgrenzen geprüft.

Die maschinenlesbare Zusammenfassung steht in [live-verification.json](live-verification.json). Vollständige technische Rohbelege und Screenshots liegen zusätzlich geschützt im lokalen Task-Artefaktordner.
