# Planbarkeit in Max Monitor

Unter **Verbrauch & Aufwand → Planbarkeit** wird aus den bestehenden Verbrauchs-
und Laufzeitdaten ein gemeinsamer Produktionsplan. Der Reiter beantwortet drei
Fragen: Passt ein geplanter Mix in den Zeitraum? Wie viele vollständige Newsletter-
Pakete trägt die gemessene Flotte? Was ändern zusätzliche Macs und eigene
Claude-Kontingente?

## Planung im Alltag

1. Einen Tag, sieben oder 28 Kalendertage wählen. Arbeitszeit und Betriebswoche
   sind einstellbar; Standard sind Mo–Fr, 08–20 Uhr, Europe/Berlin.
2. Neue Newsletter, erwartete Korrekturrunden je Newsletter und Uploads je
   Newsletter eintragen. Zusätzliche unabhängige Korrekturen/Uploads können
   hinzukommen. Ein halber Korrekturauftrag pro Newsletter bedeutet bei zehn
   Newslettern fünf Korrekturen; Teilaufträge werden aufgerundet.
3. „Bestehende Arbeit zuerst“ reserviert wartende und laufende Arbeit vollständig.
   Eine laufende Aufgabe wird vorsichtshalber mit ihren gesamten erwarteten
   Kosten gerechnet. Eine belastbare Restlaufzeit wird nicht vorgetäuscht.
   Pausierte, blockierte, manuelle und auf PM-Antwort wartende Arbeit zählt
   separat; sie beansprucht kein verfügbares Startkontingent.
4. Tagesverlauf, mögliche Paketmenge, belegte Mac-Zeit, höchste modellierte
   Wochenbelegung eines Accounts und unabhängige Restmengen prüfen. Restmengen
   sind Alternativen und dürfen nicht addiert werden. Zusätzliche Newsletter
   in dieser Zeile enthalten keine weiteren Korrekturen/Uploads.
5. Den Entwurf bei Bedarf als gemeinsame Teamplanung speichern oder als CSV
   exportieren. Alle Rollen können simulieren; Admins/Inhaber speichern mit
   Revisionsprüfung. Ein zwischenzeitlich geänderter Teamplan wird nicht
   überschrieben. Verwerfen lädt den aktuellen Teamstand erneut.

## Zwei klar bezeichnete Startpunkte

**Neuer voller Zyklus** ist ein Zukunftsszenario mit vollen Kontingenten. Bei
einem einzelnen Betriebstag beginnt es am nächsten Arbeitstag; längere Zeiträume
beginnen morgen und enthalten freie Wochenendtage. Aktuell pausierte, aber frisch
gemeldete Macs werden hier als künftig verfügbar angenommen und ausdrücklich
genannt. Das aktiviert ihre Annahme nicht.

**Aktuell verbleibend** beginnt jetzt. Hier zählen nur frische, annehmbereite Macs
mit aktuellen Account-Messungen und bestätigten Reset-Zeiten. Ein frisch
gemeldetes, ungestartetes 5-h-Fenster mit 0 % darf ohne Reset-Zeit beginnen.
Abgelaufene, noch nicht bestätigte Resets erzeugen kein künstlich volles Budget.
Künftige Resets im Modell sind Annahmen und keine bereits beobachteten Zustände.

## Messbasis und Rechenmodell

- Account-Prozentpunkte werden niemals über unterschiedliche Abonnements zu
  vermeintlich gleichwertigen Gesamtprozenten addiert. Jeder Account führt ein
  eigenes 5-h- und Wochenbudget. Mehrere Macs mit derselben Account-ID teilen es.
- Eine Aufgabenart braucht je Account mindestens fünf gültige Werte für
  5-h-Verbrauch, Wochenverbrauch und Dauer. Unbekannte, fehlende und mit null
  gerundete Kosten werden nicht als kostenlose Arbeit verrechnet. Die Oberfläche
  zeigt die Anzahl vollständig belegter Accounts und nicht eingerechnete Macs.
- Der Standard rechnet mit Mittelwert plus einer Standardabweichung für beide
  Kontingente und die Dauer. Zusätzlich bleiben 20 % der Kontingente frei.
  Beide Annahmen sind einstellbar. Das ist kein statistisches Vertrauensintervall
  und keine garantierte Liefermenge.
- Die Laufzeit ist Ende minus Anfang über sämtliche Versuche eines Auftrags.
  Gespeicherte komprimierte Aufträge behalten diese Zeitpunkte bereits, daher ist
  keine Migration oder erneute Verarbeitung von Kundenaufträgen nötig. Laufende
  Aufgaben, Überhänge und unbrauchbare Zeitstempel trainieren diese Dauer nicht.
- Die Simulation startet ganze Aufgaben in 15-Minuten-Schritten. Sie beachtet
  Arbeitszeiten, Plätze je Aufgabenart, das physische Gesamtlimit und die beiden
  Account-Budgets gleichzeitig. Laufzeiten werden auf 15 Minuten aufgerundet.
  Jede Aufgabe muss vor Betriebsschluss fertig werden; ihre gesamten Kosten
  werden beim Start reserviert. Ein neuer 5-h-Zyklus beginnt nach dem Reset erst
  mit der nächsten gestarteten Aufgabe. Wochenresets bleiben im 7-Tage-Rhythmus.
- Bestehende und neue Aufgaben werden nach Art eingeplant. Die Suche nach einer
  möglichen Paketmenge ist auf 2.000 neue Newsletter begrenzt; die UI zeigt am
  Grenzwert „≥“. Das ist ein vorsichtiger simulierter Ablauf, kein Optimierer
  für die mathematisch größtmögliche Auslastung oder ein Lieferterminplan.
- Der Tagesplan zeigt die ausgewählte Menge inklusive Queue-Reserve. Seine
  Balkenhöhe entspricht belegter Mac-Platzzeit; die Segmente entsprechen den
  Zeitanteilen der Aufgabenarten. Die Paketobergrenze ist eine separate Rechnung.

Die bestehende Zuordnung von beobachtetem Abo-Verbrauch zu parallelen Aufgaben
bleibt eine Schätzung. `summary.forecast_enabled` und der bisher deaktivierte
Ledger-`forecast`-Befehl werden nicht als validierte Vorhersage freigeschaltet.
Der neue Reiter liefert ausdrücklich eine transparente Modellrechnung. Die
Auswertung reagiert auf neue Verbrauchsberichte, ohne Claude-Anfragen auszulösen.

## Neue MacBooks und Claude-Pläne vergleichen

Ein Referenz-Mac legt die gemessenen Kosten des zugehörigen Accounts zugrunde.
Zusätzliche MacBooks ohne neue Claude-Pläne teilen dieses Account-Budget.
Eigene neue Pläne bilden getrennte Budgets; mindestens ein neues MacBook pro
neuem Plan ist erforderlich. Zusätzliche MacBooks werden gleichmäßig diesen
Szenario-Accounts zugeordnet. Die Zahl paralleler Plätze ist eine eigene Annahme.

5-h- und Wochenkapazität sind **getrennte** Faktoren. Jeweils 1× übernimmt die
Referenzkosten. Ein Faktor 2 bedeutet für dieses Fenster halb so viele
Prozentpunkte pro Aufgabe. Ein Modellfaktor ändert keine reale Kontingentgrenze.
Max 5× und Max 20× erzeugen insbesondere keinen automatisch angenommenen
4×-Faktor für die Woche. Die Anbietergrenzen sind variabel; die offizielle
[Beschreibung der Max-Limits](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)
ist aus dem Reiter verlinkt.

Die optionale Tabelle ersetzt einzelne Kosten durch eigene Annahmen nur für
den Referenz-Account und seine Szenario-Kopien. Andere gemessene Accounts
behalten ihre eigenen Werte. Änderungen an Modellen, Aufwand, Hardware oder
Kundenmix können die Referenz unpassend machen; neue Messungen sind dann nötig.
Menschliche Freigaben, spätere Störungen, zusätzliche Modelllimits sowie
Figma-/Shop-/Klaviyo-Zugänge bleiben Voraussetzungen der tatsächlichen Produktion.

## Integration und Prüfung

- `GET /v1/teams/:id/consumption` ergänzt `planning`: Revision, Konfiguration und
  inhaltsarme Planungsbelege. Die Sichtbarkeit der vorhandenen Fleet-API wird
  übernommen; versteckte oder gelöschte Macs werden nicht durch Quoten wiederhergestellt.
- `PATCH /v1/teams/:id/planning` schreibt ausschließlich die separate private
  `planning.json` im Teamverzeichnis. Validierte Felder, 32-KiB-Limit,
  atomarer Dateiaustausch und optimistische Revisionsprüfung.
- `quota_ledger.py` ergänzt additive `duration_seconds`-Metriken in Art-/Account-
  Aggregaten und Scheduling-Belegen. Der vorhandene Worker-Scorer liest weiterhin
  nur seine bisherigen Quotenfelder. Worker, Queue-Reservierungen, Aufwandspolicy,
  Accounts und Kundenobjekte werden vom Planer nicht verändert.
- Bei Verbindungsverlust verschwinden bisherige Kapazitätszahlen. Ein alter oder
  fehlender Queue-Stand und unzureichende Messwerte verhindern eine vollständige
  Machbarkeitsaussage. Persönliche Entwürfe bleiben bei Hintergrundaktualisierung erhalten.

```sh
npm test --prefix team-server
python3 -m unittest discover -s scripts -p 'test_quota_*.py'
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/review-planning.cjs
```

Die Browserabnahme verwendet eine echte isolierte Relay-Instanz mit synthetischen
Belegen. Sie prüft Mix, Überlast, Fehler, Ausbau, gespeicherten Readback,
Revisionskonflikte, Verwerfen, CSV, Verbindungsausfall und Wiederherstellung,
Tastatur-Tabs sowie 1440×900, 1024×768 und 390×844 inklusive Screenshots.
