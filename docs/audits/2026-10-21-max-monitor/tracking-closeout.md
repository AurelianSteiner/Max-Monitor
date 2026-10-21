# Kontingentanmeldung und Tracking-Update

Die Kontingentanmeldung auf Orange und das native Tracking-Update sind auf allen neun Macs live bestätigt. Der neue gespeicherte Hub-Gesamtstand bestätigt vollständige Erfassung und Berechnung; alle sechs CI-Jobs auf Main sind bestanden. F11 bleibt in [Offene Entscheidungen](open-decisions.md) offen. Die tatsächlichen Messzeitpunkte stehen in der [maschinenlesbaren Abnahme](tracking-verification.json).

## Anmeldung und reguläre Erneuerung

Die zuvor abgelaufene Verbindung auf Orange wurde durch einen neuen Monitoring-Zugang ersetzt. Die erste erfolgreiche Messung stammt vom 21.10.2026 um 17:27:31 UTC. Der nächste reguläre Providerabruf um 17:33:18 UTC liefert erneut aktuelle Kontingentwerte ohne Anmeldefehler. Die wöchentliche Auslastung liegt bei 100 Prozent; die zugehörige Annahmesperre bleibt bestehen. Es wurden keine Zugangsdaten ausgegeben oder zwischen Macs kopiert.

## Tatsächlich installierter Stand

Alle neun Macs laufen mit App **2.16.3**, basierend auf `ea2aed27bad0eca6af66b77212f1f36635c72a69`. Auf jedem Mac wurden die installierte Version, strenge Bundle-Signatur, einzelne laufende GUI, erhaltene Signaturart, Gerätebindung, lokale Tresorbereitschaft und null Alt-Schlüsselbundlesezugriffe geprüft. Die reguläre Wartung und die tatsächliche Aufgabenabfrage sind auf allen neun Macs erfolgreich.

Alle neun nativen Meldungen kommen mit `Content-Encoding: gzip` im Relay und im gespeicherten Hub-Sammelbericht an. Die gemessenen Übertragungs- und dekodierten Größen werden vom Empfänger erfasst. Der gespeicherte Sammelbericht wurde zusätzlich dekomprimiert und gegen seine SHA-256-Prüfsumme geprüft.

Der Runtime-Stand `1d569ed8363f00b21f4ea08f870dfc9d855528c2` ist mit allen 51 Manifestdateien zurückgelesen. Relay und Queue laufen; vollständige Queue-Snapshots sind frisch und ohne Quellenfehler. Dieser Stand enthält auch die parallel ergänzte Kapazitätsberechnung für ausdrücklich mit null Prozent gemeldete, frische und noch unbenutzte Providerfenster. Alte Messungen oder benutzte Fenster mit unbekanntem Reset bleiben gesperrt.

## Erhalt der laufenden Arbeit

Unser einziger Eingriff auf einem Worker betraf den alten lokalen Monitor-Bau auf Pink. Vorher waren dort null aktive, wartende oder pausierte Aufträge bestätigt. Ausschließlich die über ihre vollständige Prozesskette identifizierten Monitor-Setup- und Swift-Bauprozesse wurden beendet; anschließend installierte der reguläre, gesperrte Monitor-Abgleich das fertige Paket erfolgreich. Auf den beschäftigten Macs erfolgten unsererseits nur Lesezugriffe. Es wurde kein Newsletter-Dienst neu gestartet und kein Kundenauftrag für einen Schreibtest erzeugt.

Die parallel laufenden regulären Worker-Updates werden nicht mit einer unveränderten Dienst-PID über die gesamte Prüfzeit gleichgesetzt. Die laufenden Aufgaben auf Gelb und Schwarz waren bei der abschließenden Geräteprüfung weiter vorhanden.

## Tests und öffentliche Artefakte

- Vollständige Node-Suite unter 22.22.2: **527 bestanden**, keine Fehler oder übersprungenen Tests.
- Tatsächliche Live-Oberfläche in Chrome: 13 Prüfungen über Macs, laufende Queue, Planung und Verbrauch bei 1440×900, 1024×768 und 390×844; danach vier erneute Planungsprüfungen auf dem korrigierten Runtime-Stand. Keine Seitenfehler, kein horizontaler Überlauf und keine Schreibzugriffe. Die mobile Ansicht wurde zusätzlich mit echten Scrollpositionen für Pink, Orange und Türkis geprüft; alle neun DOM-Karten sind eindeutig.
- Alle sechs öffentlichen JavaScript-/CSS-Dateien stimmen per SHA-256 mit dem geprüften Stand überein.
- Öffentliches DMG und Worker-ZIP wurden ohne Anmeldung geladen. DMG und ZIP enthalten dieselbe streng signierte universelle App für arm64 und x86_64. Die Sparkle-Signatur ist unabhängig mit dem ursprünglichen öffentlichen Schlüssel geprüft.
- Ein zusätzlicher CI-Fehler wurde mit einem um sechs Sekunden verzögerten Swift-Compiler reproduziert: synchroner Prozessaufruf blockierte den HTTP-Empfänger und dessen Keep-Alive-Verarbeitung. Der Test startet Compiler und Encoder jetzt asynchron; dieselbe Verzögerungsprüfung besteht vollständig. Die Produktionsdateien sind davon unverändert. Das Promise-/Binärdatenverhalten wurde gegen Node 22.22.2 und die [offizielle Node-Dokumentation](https://nodejs.org/download/release/v26.8.2/docs/api/child_process.html) geprüft.
- Die Korrektur `6882969ce03e532a3aff709c1b632e8bfeee791d` ist auf Main. Alle sechs CI-Jobs sind sowohl im [geprüften Branch](https://github.com/AurelianSteiner/Max-Monitor/actions/runs/39645689401) als auch [direkt auf Main](https://github.com/AurelianSteiner/Max-Monitor/actions/runs/39646035802) bestanden.

| Öffentliches Artefakt | SHA-256 |
| --- | --- |
| Max-Monitor-2.16.3.dmg | `5c7626d6ca5a4f261b21b0836ff2ccd1addc8819799167147d9770ed599b7689` |
| Max-Monitor-worker.zip | `9a27a636abe8f15142b6b9dc16b1bab927f5aa41f2ae3160196356f31834d7c2` |

Die Liveprüfung schreibt keine Providerdaten. Die Aktualisierung der 238 Flow-Definitionen im parallel laufenden Tracking-Audit verwendet den vorhandenen begrenzten Leseweg; alle 238 Aufrufe sind erfolgreich, bei null Provider-Schreibzugriffen. Anschließend wurde ein frischer regulärer Produktionssammler gestartet, um die neue Vollständigkeitsmessung mit den tatsächlich aktualisierten Quellen zu erzeugen.

## Abschließender gespeicherter Gesamtstand

Am 21.10.2026 um **17:49:01 UTC** bestätigt der tatsächlich gespeicherte, dekomprimierte und hashgeprüfte Bericht `collectionComplete: true` und `calculationComplete: true`. Sämtliche Quellenstatus sind erfolgreich. Die Flow-Erfassung enthält null überfällige Definitionen, null ausstehende Definitions- oder Kundenlistenabrufe und null fehlgeschlagene Definitionsabrufe. Die frühere Teilabdeckungswarnung ist verschwunden.

Der zusätzliche Geräte-/Queue-Abgleich um **17:50:27 UTC** bestätigt weiter alle neun Macs mit aktuellen Meldungen, erfolgreichen Aufgabenabrufen, frischen Kontingenten und gzip-Empfang. Die laufenden Aufträge auf Gelb und Schwarz bleiben vorhanden; acht durchgehend vorhandene Laufkennungen behalten auch ihre tatsächlichen Prozesskennungen. Bestehende API-Belege ohne Auftragskontext bleiben im übergreifenden Bericht als unzugeordnet erkennbar. Diese Abnahme bestätigt die Monitoring-Anmeldung, den nativen Tracking-Rollout und die aktuellen Erfassungs-/Berechnungsergebnisse.
