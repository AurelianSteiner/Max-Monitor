# Aufgaben und Claude-Kontingente

Der passive Kontingentdienst ergänzt Max Monitor um einen dauerhaften SQLite-
Verlauf. Er startet keine Produktionsaufgaben, ändert keine Annahmefreigabe und
fragt Claude nicht zusätzlich ab. Fünfstundenfenster und Wochenfenster werden
getrennt geführt; ein 24-Stunden-Bericht ist kein tägliches Anbieterlimit.

## Quellen und Betrieb

- `max-monitor-quota.service` liest alle 15 Sekunden die bestehende Fleet-Datei
  `/var/lib/max-monitor/RSMACS01/fleet.json`. Nur frische, fehlerfreie Werte des
  ausdrücklich gebundenen Monitoring-Accounts werden übernommen. Die vorhandene
  Messfrequenz des Providers bleibt bestehen.
- `de.rs.max-monitor.quota` liest auf jedem Mac jede Minute die Worker-Datenbank
  ausschließlich mit `mode=ro` und seit dem letzten erfolgreichen Export neu
  angehängte Zeilen in den Claude-Streams. Beim ersten Start werden die letzten
  72 Stunden und weiterhin offene Läufe nacherfasst. Auch Sales-Streams außerhalb
  der Worker-Datenbank werden als eigene Inventareinträge erfasst; unbekannte
  Kunden oder Endzustände werden ausdrücklich nicht geraten.
- Exportiert werden ausschließlich Aufgaben-/Nachrichten-IDs, Kunde, Titel,
  Aufgabenart, Zustand, Zeiten, Modell, Token-Zähler und beide Kontingentstände.
  Prompts, Werkzeugargumente, Antworten, Bilder und Zugangsdaten bleiben lokal.
- Der Export verwendet den bestehenden RS-Hub-SSH-Zugang des Workers. Keine
  Schlüssel werden kopiert; neue Zugänge, APIs oder Claude-Sitzungen entstehen
  nicht. Byte-Cursor werden erst nach der bestätigten SQLite-Transaktion auf dem
  Hub weitergesetzt. Nachrichten-IDs und Kontingentereignisse sind global
  idempotent, auch bei kopierten Fortsetzungsprotokollen auf einem anderen Mac.
- Datenbank: `/var/lib/max-monitor-quota/ledger.sqlite`, WAL und Transaktionen,
  ausschließlich private Dateirechte. Die Rohmetadaten bleiben für spätere
  Neuauswertung erhalten. JSON-Berichte für 24 und 72 Stunden stehen unter
  `/var/lib/max-monitor-quota/reports/summary-{24,72}h.json`.
  Die Berichte werden alle fünf Minuten erneuert; der Kontingentverlauf wird
  unabhängig davon alle 15 Sekunden eingelesen.

## Messung und Schätzung

Eine Kontingentänderung ist eine Beobachtung auf Account-Ebene. Sie wird niemals
als exakt gemessener Verbrauch einer einzelnen Aufgabe ausgegeben. Bei mehreren
Aufgaben wird die beobachtete Änderung einmal auf die deduplizierten Nachrichten
im Zeitintervall verteilt. Der ausdrücklich heuristische Arbeitsindikator ist
`input + cache_creation + 0.1 * cache_read + 5 * output`; er ist keine Umrechnung
von API-Tokens oder API-Kosten in Abo-Kontingent. Auch bei nur einer Aufgabe kann
private Nutzung desselben Accounts enthalten sein. Ohne zuordenbare Nachrichten
bleibt die Änderung als `unattributed_pp` separat erhalten.

Fenster mit anderem Reset bilden einen neuen Zähler; negative Differenzen werden
nicht als Verbrauch gerechnet. Rückläufige Werte im selben Fenster lassen den
Höchststand stehen, damit verspätete/gerundete Messungen nicht doppelt zählen.
Lücken über 30 Minuten und fehlende Grenzen werden separat gezählt. Die erste
Messung einer Woche beweist keinen vorherigen Verbrauch. Unbekannt bleibt `null`.

Historische `rate_limit_event`-Zeilen haben häufig keinen eigenen Zeitstempel.
Sie erhalten die letzte ausdrücklich datierte Stream-Zeit mit Kennzeichnung
`adjacent`. Ohne Zeitanker bleibt die Zeit unbekannt. Die Zuordnung zu einem
historischen Account ist nur eine als `inferred_reset_cycle` bezeichnete
Schlussfolgerung: Der Wochenreset muss eindeutig zu genau einem beobachteten
Account im selben oder unmittelbar vorherigen Wochenzyklus passen. Ein aktueller
Login auf dem Mac beweist niemals den Account eines übernommenen alten Streams.

Durchschnitte enthalten nur abgeschlossene Aufträge mit mindestens 80 % erfassten
Nachrichten in brauchbaren Wochenmessintervallen, ohne bekannte Lese- oder
Nachlieferungslücke. Versuche werden zum gleichen Auftragsereignis zusammengefasst;
Fortsetzungen werden nicht als zusätzlich fertiggestellte Aufträge gezählt.
Fehlversuche und laufende Arbeit bleiben in der Gesamtbuchhaltung sichtbar.
Mittlere Werte, Median, p90 und Stichprobenzahl werden nach Aufgabe, Kunde,
Aufgabenart, Kunde/Aufgabenart und Account/Aufgabenart ausgegeben.

Ab fünf geeigneten abgeschlossenen Aufträgen je Account und Aufgabenart kann die
CLI eine vorläufige Kapazitätsschätzung erstellen. Unterschiedliche Abos werden
nicht über gleiche Prozentwerte gleichgesetzt. Die Schätzung nennt eine obere
Grenze aus Wochen- und Fünfstundenbudget; Slotgrenzen, Ausfälle, Reserven und
Auftragsfristen müssen im anschließenden Annahmeplan zusätzlich berücksichtigt
werden. Bei fehlenden Daten liefert sie `null`, keine erfundene Wochenkapazität.
Solange historische Stream-Dateien noch nachgeliefert werden, bleibt die
Kapazitätsschätzung ebenfalls gesperrt; unvollständige Parallelverläufe dürfen
keinen scheinbar vollständigen Verbrauch erzeugen.

## Einrichtung und Prüfung

```sh
python3 scripts/install_quota_tracker.py --generate-only /tmp/quota-preview
python3 scripts/install_quota_tracker.py --install
# Pro Worker über den bestehenden Max-Monitor-Wartungsweg nach check/diagnose:
python3 /gesicherter/pfad/quota_worker.py --install
```

Der Installer ersetzt ausschließlich eigene Kontingentdateien und den eigenen
Dienst. Vorhandene Fassungen liegen unter `/var/backups/max-monitor-quota/`.
Die SQLite-Datei bleibt bei Updates und beim Stoppen des Dienstes erhalten.
Der Worker-Installer ersetzt ausschließlich seinen eigenen LaunchAgent; der
Newsletter-Dienst und laufende Aufträge werden nicht neu gestartet.

```sh
systemctl is-active max-monitor-quota.service
python3 /opt/max-monitor-quota/quota_ledger.py status
python3 /opt/max-monitor-quota/quota_ledger.py report --hours 24
python3 /opt/max-monitor-quota/quota_ledger.py report --hours 72
python3 /opt/max-monitor-quota/quota_ledger.py forecast \
  --accounts 'account1@example.com,account2@example.com,account3@example.com' \
  --mix 'newsletter=0.6,correction=0.3,upload=0.1'
```

Erfolg verlangt neue Datenbankeinträge, frische Collector-Meldungen aller
erwarteten Worker, neue Kontingentmessungen und auswertbare Aufgaben. Ein laufender
Dienst allein beweist weder vollständige historische Abdeckung noch belastbare
Prognosen. Prüfung: `python3 -m unittest discover -s scripts -p test_quota_tracker.py`.
