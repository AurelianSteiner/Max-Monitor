# Verbrauch & Aufwand

## Sales-Abschluss und Nachziehen vorhandener Messdaten

Der Mac-Beobachter liest die exakte Claude-Sitzung und den ersten Zeitstempel aus
dem Anfang des Sales-Streams, auch wenn die aktive Laufdatei nach dem Abschluss
bereits entfernt wurde. Damit bleiben die zugehörigen Unteragenten auffindbar.
Der bestätigte Abschluss derselben zentralen Sales-Auftrags-ID schließt außerdem
bereits erfasste, verwaiste Unterläufe. Seit dem Fehleraudit vom 26.10.2026 endet
eine Sales-Phase auch, wenn der Hub-Job blockiert ist (`blockiert`), nicht mehr
gelistet wird (abgebrochen, `abgebrochen`) oder ohne lesbaren Abschlusszeitpunkt
bzw. auf einem anderen Mac fertig wurde. Endzeit ist der Abschluss des Jobs, sonst
der letzte erfasste Schritt der Phase. Später begonnene oder nicht gelistete
Phasen bleiben offen, bis sie 30 Minuten still sind.

Worker-Läufe (alle Arten außer Sales) behalten Ende und Zustand aus der
Worker-Datenbank. Der Queue-Abschluss des Auftrags gilt nur, solange der Worker
noch kein Ende meldet. Sprachfassungen als eigene ClickUp-Aufgabe zählen wie beim
Worker (`runs.fassung`, `src/jobs.js runKind`) als Übersetzung; bereits als
Newsletter erfasste Läufe wechseln mit ihren Ereignissen in den Übersetzungsauftrag.

Für historische Lücken arbeitet `sales_usage_backfill.py` ausschließlich auf einer
SQLite-Sicherung. Geprüfte Roharchive aller parallelen Aufgaben werden dort
wiederhergestellt, damit sich der Nenner der Verbrauchszuordnung nicht verändert.
Danach werden vorhandene Sales-Streams der Macs über denselben Hub-Zugang mit
eigenem Cursor nachgeliefert. Es gibt keine neuen Claude-Aufrufe.

```sh
python3 /opt/max-monitor-quota/sales_usage_backfill.py prepare \
  --directory /var/lib/max-monitor-quota/backfills/sales-YYYYMMDD
# Je Mac über Max Monitor; eigener Cursor, keine Änderung am normalen Cursor:
python3 ~/.local/share/max-monitor-quota/quota_worker.py --once --hours 120 \
  --cache ~/.local/share/max-monitor-quota/sales-backfill-YYYYMMDD.sqlite \
  --sales-backfill-db /var/lib/max-monitor-quota/backfills/sales-YYYYMMDD/ledger.sqlite
python3 /opt/max-monitor-quota/sales_usage_backfill.py finish \
  --directory /var/lib/max-monitor-quota/backfills/sales-YYYYMMDD
```

Importiert werden nur vollständig belegte Sales-Aufgabensummen mit unveränderter,
erneut bestätigter Abschlussidentität. Bereits vollständige Messungen bleiben
erhalten; unvollständige Werte werden nur ohne Tokenverlust ersetzt. Der
Tracking-Start, Produktionsaufträge und vorhandene Originalbelege bleiben erhalten.
Ein Replay-Flag wird vom normalen Live-Ledger abgewiesen. Vorherige Datenbanken,
ersetzte Messwerte und das Importergebnis bleiben als Rückfallbeleg erhalten.
Fehlende Quoten werden weiterhin als unbekannt behandelt.

## Durchschnittswerte bei neuen Aufgaben und alle zwölf Stunden

Der bestehende Hub-Beobachter berechnet sämtliche Aufgabenarten neu, sobald neue
Aufgaben in der zentralen Queue oder in Worker-Meldungen erscheinen. Auch geänderte
Abschlüsse, nachgelieferte Token-/Werkzeugbelege und neue Kontingentmessungen lösen
die Neuberechnung aus. Eingang und Bestätigung liegen transaktional im Ledger;
gleichzeitige Meldungen gehen nicht durch eine laufende Berechnung verloren.
Identische Aufgabenmeldungen und reine Fortschrittsänderungen lösen keine zusätzliche
Berechnung aus. Der bestehende 15-Sekunden-Zyklus bündelt Eingangsspitzen. Die
Mac-Beobachter liefern ihre Streams weiterhin minütlich. Ohne Änderungen bleibt die
minütliche Veröffentlichung als Frischeprüfung erhalten.

Zusätzlich wird ab dem ersten gespeicherten Stand **alle zwölf Stunden** ein
vollständiger Durchschnittsstand aller Aufgabenarten festgehalten – auch bei
unveränderten Werten. Aufgabenereignisse verschieben diesen festen Termin nicht.
Der Anker und die letzten Termine bleiben über Dienstneustarts erhalten. Nach einer
Unterbrechung wird der aktuelle Stand beim nächsten Zyklus erfasst; nicht beobachtete
historische Zeitpunkte werden nicht nachträglich mit erfundenen Werten aufgefüllt.

Die Durchschnittswerte verwenden rollierend die **letzten fünf Tage (120 Stunden)**.
Maßgeblich ist der Abschlusszeitpunkt; die vollständigen Kosten aller Versuche und
Follow-ups einer Aufgabe bleiben zusammen. Das gilt für alle sechs Aufgabenarten,
Accounts und Kunden sowie deren abgeleitete Planungskosten. Ältere Abschlüsse
fallen bei der minütlichen Frischeprüfung auch ohne neue Aufgaben heraus. Historie
und kumulative Erfassungszähler bleiben erhalten. `summary.average_window` und
gespeicherte Durchschnittsstände enthalten die Fenstergrenzen.
Das Zwölf-Stunden-Intervall setzt die Stichprobe nicht zurück. Neue/laufende Aufgaben zählen weiterhin
erst mit einem abgeschlossenen, ausreichend belegten Lauf in den jeweiligen
Fensterdurchschnitt. Fünfstunden- und Wochenmittel speichern ihre auswertbaren
Aufgabenzahlen getrennt. Alle sechs Arten werden auch ohne auswertbaren Abschluss
aufgeführt, dann mit `n: 0` und `mean: null`.

Zusätzliche Ereignisstände werden bei veränderten Aggregaten oder neuen/geänderten
Aufgaben gespeichert. Unveränderte periodische Frischeprüfungen erzeugen keinen
doppelten Verlauf. Die vollständigen kleinen Aggregate liegen SHA-256-geprüft mit
zlib 9 in `raw_archives`; `average_snapshots` enthält lediglich einen kleinen
Zeit-/Hash-Index. Rohbelege oder einzelne Aufgaben werden dafür nicht dupliziert.
Der bisherige Archiv-Export erfasst den Verlauf vollständig. Ein Publikationsfehler
bestätigt weder Eingang noch Zwölf-Stunden-Termin; die nächste Runde versucht erneut.

Die bestehende Verbrauchs-API liefert unter `summary.average_updates` den Zeitpunkt
der Neuberechnung, Auslöser, nächsten Zwölf-Stunden-Termin und den letzten
gespeicherten Stand. Der geschützte Hub kann die letzten Stände direkt lesen:

```sh
python3 /opt/max-monitor-quota/quota_ledger.py average-history --limit 20
```

Es sind keine zusätzlichen LLM-Aufrufe, Mac-Dienste oder Desktop-Weckaufträge nötig.
Newsletter-Aufträge und Freigaben werden dabei nicht verändert.

## Frische, Wiederherstellung und verlustfreie Ablage

`max-monitor-quota-watchdog.timer` prüft alle 30 Sekunden den Inhalt von
`generated_at`, nicht nur Prozessstatus oder Dateidatum. Nach zwei getrennten
Prüfungen mit mehr als drei Minuten alten/ungültigen Daten startet er ausschließlich
`max-monitor-quota.service` neu. Bewusst gestoppte Dienste bleiben gestoppt;
Anlaufzeit und zehn Minuten Abstand zwischen Wiederherstellungsversuchen schützen
vor Neustartschleifen. Der private Zustandsbeleg liegt unter
`/var/lib/max-monitor-quota-watchdog/state.json`. Newsletter-Worker, Hub, Queue
und Relay werden nicht neu gestartet.

Die Zuordnung eines Antwortzugs zu seiner zeitlich nächsten Quotenmessung nutzt
eine binäre Suche. Gleiche Zeitpunkte, gleich große Abstände und unbekannte
Account-Zuordnungen behalten das bisherige Ergebnis.

Jede Ledger-Verbindung begrenzt das nach einem sicheren WAL-Recycling aufbewahrte
Journal auf 1 MiB. Passive Checkpoints und ein kleinerer Auto-Checkpoint erhalten
aktive Leser und sämtliche bestätigten Transaktionen; eine gerade aktive WAL kann
vorübergehend größer sein.

Vor der bisherigen Bereinigung des heißen Datenbestands werden alle betroffenen
Zeilen einschließlich sämtlicher Spalten in `raw_archives` verlustfrei mit zlib 9
komprimiert und per SHA-256 geprüft. Archiv und Entfernung werden gemeinsam
bestätigt; bei einem Fehler bleiben die Rohzeilen erhalten. Bereits vor Einführung
entfernte Rohdaten werden dadurch nicht rekonstruiert. Die vorhandenen komprimierten
Aufgabensummen bleiben zusätzlich erhalten.

```sh
python3 /opt/max-monitor-quota/quota_archive.py verify
python3 /opt/max-monitor-quota/quota_archive.py export --output /private/new-export.jsonl.xz
```

Für unveränderliche Wiederherstellungshistorie kann ein komprimiertes SquashFS
unter den bisherigen Pfaden eingehängt werden. `scripts/cold_history.py` sichert
vorher die vollständigen Dateimetadaten einschließlich Nanosekunden und prüft
danach jede Datei, Verknüpfung, Berechtigung und jedes erweiterte Attribut. Inhalte
werden per SHA-256 verglichen; Hardlinks werden nur einmal gelesen. Originale
werden erst nach erfolgreicher Prüfung und bestätigter Einhängung freigegeben.
Aktive Datenbanken oder laufende Auftragsdateien werden nicht umgepackt.

`scripts/mount_cold_history.py` bindet nur eine zuvor vollständig geprüfte,
unveränderliche Historie ein. Der Beleg ist an Quellpfad, Image-Hash und den
Metadatenkatalog gebunden. Vor der Einhängung wird der Quellstand erneut geprüft.
Ein privater Bind-Mount hält den alten Bestand während der atomaren Überdeckung
zugänglich; dadurch bleiben bestehende Leser und sämtliche ursprünglichen Pfade
erhalten. Über dem unveränderlichen SquashFS liegt eine kleine schreibbare
Overlay-Schicht: vorhandene SQLite-Leser dürfen dort ihre Journaldateien anlegen,
und spätere Belege bleiben schreibbar. Normale Lesezugriffe kopieren die großen
Dateien nicht aus dem komprimierten Bestand. Auch die Mount-Namespaces der
laufenden Hub-, Queue- und Relay-Dienste werden vor der Freigabe geprüft.
Die beiden Einhängungen und ihre Reihenfolge werden dauerhaft in `/etc/fstab` hinterlegt. Erst danach
werden die nachweislich identischen unkomprimierten Kopien freigegeben.
Die Konfiguration wird vor dem atomaren Überdecken dauerhaft gespeichert.
Nach dem Überdecken bleiben bei Fehlern beide Ebenen und die Originale erhalten;
ein automatischer Rollback könnte sonst neue Overlay-Schreibdaten verdecken.

Der Linux-Abnahmetest `scripts/test_cold_history_linux.py` führt diesen gesamten
Weg mit isolierten Testdateien, Hardlinks, erweiterten Attributen und einer echten
SQLite-Datei durch. Er verändert keine produktive fstab und läuft nur mit
Linux-Mount-Berechtigung. Vollständige Original-Metadaten bleiben als komprimierter
Katalog neben dem Image verfügbar, auch die im Dateisystem auf Sekunden gerundeten
Zeitstempel in ihrer ursprünglichen Nanosekundenauflösung.

## Automatische Komprimierung neuer Archivbestände

`max-monitor-cold-storage.timer` läuft alle sechs Stunden (00:35, 06:35,
12:35 und 18:35 UTC, bis fünf Minuten zufällig versetzt). Verpasste Läufe
werden nach einem Neustart nachgeholt. Pro Lauf wird höchstens ein neuer
Bestand komprimiert. Der eigene Dienst nutzt zwei CPU-Kerne, höchstens 8 GiB
RAM und die niedrigste CPU-/I/O-Priorität. Hub, Queue, Relay und Worker werden
nicht angehalten oder neu gestartet.
Der Image-Ersteller begrenzt seinen eigenen Cache zusätzlich auf 1 GiB.

Automatisch erkannt werden ausschließlich datierte historische Wurzeln
`/var/lib/rs-hub-recovery-history-YYYYMMDD`, abgeschlossene Filestage-Audits,
datierte Feedback-Reconciliation-Bestände und datierte Source-Original-Pakete.
Recovery-Snapshots brauchen vollständige Manifeste; Filestage-Audits brauchen
ihren `collectionComplete`-Beleg. Undatierte aktive Ablagen, aktuelle
Datenbanken, Aufträge und die vom Backup-Pruner verwalteten Sicherungen auf
dem Backup-Volume gehören nicht zu dieser Auswahl. Ihre vorhandenen
Kompressionsformate und Aufbewahrungsregeln bleiben bestehen.

Jeder Bestand muss mindestens 72 Stunden ohne Änderung sein und mindestens
24 Stunden mit demselben Metadaten-Fingerabdruck beobachtet worden sein.
Inhalt, Größe, Modus, Eigentümer, mtime, ctime, Inode, Hardlinks und xattrs
gehen in die Prüfungen ein; ctime erkennt auch Änderungen mit nachträglich
zurückgesetzter mtime. Ein offener Schreiber, ein Arbeits-/Root-Verzeichnis,
ein Verzeichnis-Handle oder eine gemeinsam schreibbar gemappte Datei
verhindert die Aktivierung. Zusätzliche Mounts, Spezialdateien und Hardlinks
außerhalb des Bestands werden ausgeschlossen.

Vorher müssen die unkomprimierten Originale, das neue Image und eine Reserve
von mindestens 10 GiB bzw. 5 % des Dateisystems gleichzeitig Platz haben.
Unterhalb der Reserve meldet der Dienst einen Fehler und bewahrt alle Daten.
Ein Image ohne mindestens 10 % Ersparnis wird verworfen; derselbe unveränderte
Bestand wird danach nicht wiederholt komprimiert.

Nach vollständiger Inhaltsprüfung wird unmittelbar vor dem Überdecken noch
einmal auf Schreiber und Änderungen geprüft. Vor der Speicherfreigabe erfolgt
dies erneut über den privaten Original-Bind-Mount; zusätzlich müssen alle
erreichbaren Prozess-Mount-Namespaces den neuen Bestand sehen. Bei einem
Konflikt in dieser letzten Phase bleiben Image, Schreibschicht und Originale
erhalten. Es gibt dann keinen automatischen Rollback, der neue Schreibdaten
verdecken könnte. Der nächste Lauf meldet den aufbewahrten Vorgang zur sicheren
Wiederherstellung, statt Daten zu entfernen. Unveröffentlichte, unterbrochene
Image-Erstellungen dürfen automatisch neu begonnen werden.

Zustand und Beobachtungen liegen privat unter
`/var/lib/max-monitor-cold-storage/`; automatisch erzeugte Images,
vollständige Metadaten und Prüfbelege unter
`/var/lib/rs-hub-compressed-history/automatic/`. Bereits komprimierte Archive
werden nicht erneut überdeckt. Die kleine Overlay-Schreibschicht erhält
spätere Belege und SQLite-Koordinationsdateien. Verlustfreie Komprimierung
reduziert den Zuwachs, ersetzt aber keine Kapazitätsplanung für unbegrenzt
wachsende oder bereits komprimierte aktive Daten.

```sh
python3 scripts/install_cold_storage.py --generate-only /tmp/cold-storage-preview
python3 scripts/install_cold_storage.py --install
python3 /opt/max-monitor-cold-storage/auto_cold_storage.py --check
systemctl start max-monitor-cold-storage.service
systemctl list-timers max-monitor-cold-storage.timer
cat /var/lib/max-monitor-cold-storage/status.json
```

`--check` verändert weder die Beobachtungsfrist noch Dateien und komprimiert
nichts. Die Installation aktiviert nur den eigenen neuen Timer. Der Dienst
braucht den Host-Mount-Namespace; `PrivateTmp`, `ProtectSystem`, `ProtectHome`
und andere Einstellungen, die einen privaten Mount-Namespace erzeugen,
dürfen hier nicht eingeschaltet werden.

Max Monitor zeigt einen eigenen Reiter zwischen Queue & Macs und Account Limits.
Der separate Beobachter läuft auf dem RS Hub und auf allen acht Worker-Macs.
Er entscheidet nicht über Aufträge und verändert keine Kundenobjekte.

## Messung ab festem Start

`quota_ledger.py reset --since <ISO-UTC>` leert ausschließlich diese Statistik und
setzt einen persistenten Tracking-Start. Alte Quoten, Aufgaben und Ereignisse
werden bei späterem Replay abgewiesen. Der Observer setzt seine eigenen Cursor
einmal zurück, liest die seit dem Start entstandenen Daten erneut und überträgt
keine früheren Ereignisse. Worker-Datenbanken, Ergebnisse und Originalverläufe
bleiben erhalten. Vor dem Start begonnene Aufgaben zählen als Überhang und bilden
keinen vollständigen Aufgabenverbrauch im Durchschnitt ab.

Jede Aufgabe wird über Art und vollständige Auftrags-ID einschließlich Auslöser
erfasst. Wiederholungen und Mac-Wechsel zählen als Versuche derselben Aufgabe.
Slicing-, Ablage-, Übersetzungs- und zugeordnete Claude-Unteragentenverläufe
fließen in die ursprüngliche Aufgabe ein. Nachrichten-IDs verhindern Doppelzählung.
Fehlende Messungen bleiben unbekannt. Die Oberfläche nennt abgeschlossene und
auswertbare Aufgaben je Fenster getrennt; laufende und noch unvollständig
gemessene Aufgaben verringern den Durchschnitt nicht künstlich. Auch gescheiterte
abgeschlossene Versuche bleiben als Verbrauch erfasst.

Beobachtet werden Account-Prozentpunkte im Fünfstunden- und Wochenfenster.
Reset-Grenzen, Zähleranstiege über Datenlücken von mehr als 30 Minuten und
rückläufige Zähler werden nicht als Verbrauch verrechnet. Die Rohauflösung
beträgt derzeit einen Prozentpunkt. Für jedes Account-Fenster und jeden
Reset-Zyklus bildet die Auswertung die Differenzen ausschließlich aus CLI-
Messungen (Streams und bestehende Probes), sobald zwei unterschiedliche
Messzeitpunkte vorliegen. Andernfalls dienen ausschließlich native Meldungen
als Rückfallquelle. Native App und CLI runden unterschiedlich und werden deshalb
nicht zu einem gemeinsamen Höchststand vermischt. Numerisches Gleitkomma-Rauschen
unter einem Millionstel Prozentpunkt ist kein gemessener Verbrauch.
Die Zuordnung zu parallelen Aufgaben wird je Account und Kontingentfenster geprüft:
Die Auswertung bündelt zusammenhängende, vollständig mit Token-Metadaten erfasste
Intervalle zu mindestens drei beobachteten Prozentpunkten. Aus mindestens acht
Blöcken dienen die zeitlich ersten 60 % (mindestens vier) zur Kalibrierung einer
Account-Skalierung. Auf mindestens vier späteren, zurückgehaltenen Blöcken werden
Antwortanzahl und Tokengewicht verglichen. Das Tokengewicht wird nur bei mindestens
10 % geringerem mittlerem absoluten Fehler und 5 % geringerem RMSE verwendet.
Die Prüfung wird beim Minutenbericht mit dem vorhandenen 48-Stunden-Puffer erneuert;
sie startet keine Modellanfragen und benötigt keine zusätzliche Infrastruktur.

Das Tokengewicht berücksichtigt Ein-/Ausgabe, Cache-Schreiben getrennt nach
5 Minuten/1 Stunde, Cache-Lesen, exaktes Modell und gemessenen Geschwindigkeitsmodus.
Die am 19.10.2026 geprüften API-Listenpreise sind ausschließlich ein relativer
Schlüssel, keine dokumentierte Umrechnung in Abo-Prozentpunkte. Unterstützt werden
Opus 5.5, Sonnet 5.5 und Haiku 4.5; unbekannte Modelle, fehlende Cache-Laufzeit,
fehlender Geschwindigkeitsmodus und unvollständige Intervalle fallen auf die
gleichmäßige Verteilung je Antwortzug zurück. Es gibt keine hochgerechneten
Prozentpunkte ohne beobachteten Kontingentanstieg. Die Summe der Anteile bleibt
gleich der beobachteten Account-Differenz. Auch die bessere Variante ist eine
Schätzung, keine gemessene Einzelaufgabenabrechnung. Ein besserer Account-Test
belegt noch keine exakt bekannte Verteilung zwischen parallelen Aufgaben.
Ein gleichbleibender gerundeter Zähler bedeutet keinen belegten Nullverbrauch:
Antwortzüge bleiben bis zum nächsten ganzen Prozentpunkt gemeinsam offen und
werden erst dann auf die beteiligten Aufgaben verteilt. So entstehen aus vielen
kleinen Aufgaben keine künstlichen Nullwerte im Durchschnitt.
Bleibt derselbe gerundete Zähler auch an beiden Seiten einer Messlücke gleich,
bleiben die Antwortzüge dieses Plateaus offen. Erst ein späterer beobachteter
Anstieg innerhalb eines gültigen Messintervalls schließt es. Ein Anstieg über
die Lücke selbst wird weiterhin keiner Aufgabe zugerechnet.
Unbeobachtete Privatnutzung desselben Accounts kann enthalten sein. Es gibt keine angebliche Token-zu-Abo-
Umrechnung; Kapazitätsprognosen bleiben bis zur Kalibrierung deaktiviert.

## Vollständige, komprimierte Messpakete

Der Mac liest die vorhandenen Streams inkrementell und überträgt SHA-256-geprüfte
zlib-9-Pakete mit sämtlichen unterschiedlichen, inhaltsfreien Usage-Messständen:
Tokenzähler einschließlich Cache-TTL, Modell, Speed/Service-Tier, numerische
Provider-Zusatzfelder, Iterations- und Server-Tool-Zähler. SDK-Ergebnissummen werden
als eigene Belege gespeichert und niemals zu bereits gezählten Nachrichten addiert.
Werkzeuge liefern ID, Name, Zeitpunkt, Fehlerstatus und serialisierte Ein-/Ausgabe-
Bytes; diese Bytes werden nicht als zusätzliche Tokens ausgegeben. Prompts,
Nachrichtentexte, Tool-Argumente, Tool-Ergebnisse und Zugangsdaten verlassen den Mac
dabei nicht. Werkzeugkosten werden nicht pauschal auf die Usage aufgeschlagen.

Die zentrale Übernahme speichert alle sicheren Messstände verlustfrei in
`raw_archives`, gemeinsam mit dem kleinen Token-/Werkzeugindex in einer Transaktion.
Erst nach Bestätigung rückt der Mac-Cursor vor. Gleiche Pakete werden per Inhalts-
Hash dedupliziert; geänderte Messstände bleiben separat erhalten. Der bestehende
Archiv-Verifikations-/Exportweg erfasst auch diese Pakete. Bei der Bereinigung
nach 48 Stunden werden auch Cache-Features und Werkzeugindex vollständig archiviert.
Es werden keine Messpakete automatisch gelöscht. Nur die kleinen Indizes und
komprimierten Aufgabensummen werden für die laufende Auswertung gelesen.

Die einmalige Änderung der Usage-Schemaversion setzt ausschließlich die Observer-
Cursor zurück und ergänzt die noch vorhandenen Streams seit dem Tracking-Start.
Newsletter-Dienste, Aufträge, Queue und Kundendaten bleiben unberührt. Die API liefert
unter `precision` die Auswahl, Blockanzahlen und Fehlermaße je Account/Fenster sowie
unter `evidence_storage` Roh-/Kompressionsgrößen. Einzelaufgaben enthalten
`token_counts`, `models`, `tools` und `allocation_methods`.

Primärquellen: [API-Preise](https://platform.claude.com/docs/en/about-claude/pricing),
[Cache-Zähler](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
[Usage-Erfassung](https://code.claude.com/docs/en/monitoring-usage).

## Zentrale Aufwandseinstellungen

`PATCH /v1/teams/:id/effort` erlaubt ausschließlich Admins und dem Inhaber
validierte Stufen je fest definierter Phase. Die aktuelle Revision muss
mitgegeben werden; bei zwischenzeitlicher Änderung folgt HTTP 409. Ein leerer
Sollwert erhält die vorhandene Einstellung des jeweiligen Macs.

Der Observer übernimmt die Policy innerhalb einer Minute atomar in seinen
privaten Laufzeitordner. `src/effort-policy.js` im Newsletter-Worker liest sie
bei jedem neuen Phasenstart und hält den Stand in einem Phasenbeleg fest.
Laufende Prozesse und Fortsetzungen behalten ihren Beleg; ältere Fortsetzungen
ohne Beleg übernehmen keine später eingeführte Policy. Art-Director- und
Bau-Aufrufe erhalten getrennte Stufen über den vorhandenen Headless-Hook.
Andere Werkzeugparameter und sämtliche Produktionsschutzregeln bleiben erhalten.
Die Oberfläche zeigt zentralen Sollwert und frische Bereitschaftsmeldung der
Macs getrennt. Eine Bereitschaftsmeldung ist kein Beleg für einen schon damit
abgeschlossenen Produktionsauftrag.

## Ablage und Speicher

- Hub: `/var/lib/max-monitor-quota/ledger.sqlite`, privat, SQLite WAL.
- Abgeschlossene Aufgaben: ein mit zlib komprimierter Messdatensatz pro Auftrag,
  über alle Zeiträume seit Tracking-Start kumulativ. Kein kompletter Chatverlauf.
- Abgeschlossene Aufgaben behalten Rohereignisse für volle 48 Stunden im aktiven
  Messbestand. So bleiben spätere Abschlussmeldungen und die Verteilung auf
  parallele Aufgaben vollständig auswertbar. Danach werden die Rohzeilen
  verlustfrei archiviert. Laufende Aufgaben behalten
  ihre Belege, bis ihr Abschluss ausgewertet ist. Quotenmessungen: höchstens 48 h
  plus 30 Minuten Rand für Messintervalle.
- Öffentliche, inhaltsarme Zusammenfassung: jede Minute atomar unter
  `/var/lib/max-monitor-quota/public/RSMACS01.json`, nur über authentifizierte
  Team-API lesbar. Keine Prompts, Werkzeugargumente oder Zugangsdaten.
- Policy: `/var/lib/max-monitor/RSMACS01/effort-policy.json`, privat.
- `max-monitor-quota.service`: bestehende Fleet-Datei alle 15 Sekunden, keine
  zusätzlichen Claude-Anfragen. `de.rs.max-monitor.quota`: einmal pro Minute je Mac.

## Betrieb und Prüfung

```sh
python3 scripts/install_quota_tracker.py --generate-only /tmp/quota-preview
python3 scripts/install_quota_tracker.py --install
python3 /opt/max-monitor-quota/quota_ledger.py dashboard
python3 /opt/max-monitor-quota/quota_ledger.py status
python3 -m unittest discover -s scripts -p test_quota_tracker.py
```

Observer über den vorhandenen Max-Monitor-Wartungsweg nach check/diagnose
aktualisieren. Die Installation ersetzt nur ihren eigenen LaunchAgent,
nicht den Newsletter-Dienst. Erfolg verlangt frische Meldungen jedes Macs,
API-Readback, tatsächlich gespeicherte neue Messdaten und Browserprüfung.

## Reset-aware scheduling evidence (18.10.2026)

The compact summary now includes `scheduling.workers`: a hashed shared account ID,
per-window measurement timestamps/reset/usage, and per-account/task-kind mean,
standard deviation and sample count. The worker's existing authenticated Fleet
read carries this optional evidence. Since 21.10.2026 the worker orders Macs and
gates its own Claude accounts with `src/quota-pacing.js` (weekly pace line,
5h and weekly guards, soft cap and look-ahead tier); its own per-account
`quota_slots` heartbeat takes precedence, this row is the fallback. No new
admission authority is created.

Only live workers are exported: a worker without a Fleet machine row
(`lastSeenAt`), Hub heartbeat (`observedWorkers`) or observer report for 24 hours
loses its remembered account pool and its open account binding and is no longer
part of `scheduling.workers`. A fresh observer report (at most 45 seconds old)
without `claudeAccounts` forgets the pool at once, so the Mac falls back to its
bound app account.

Existing CapacityGate CLI probes and stream quota events are attributed to an
account by reset fingerprint (`resolve`). The universe holds every bound
account's native/probe resets and the reset fingerprints of both slots of every
Mac's account pool (`pool_resets`, from `claudeAccounts`). The weekly reset (or
its preceding cycle) must match exactly one of them; a candidate whose own
observed 5h window at that time has another reset is excluded. The match must
be an account the stream's worker was ever bound to, unless the 5h reset matches
that account as well (cross-confirmation). Pool slots are never returned:
without provider identity their streams stay unattributed instead of landing on
an unrelated account with the same weekly reset (21.10.2026: a pool slot's
stream overwrote another Mac's bound account). Anchors retain identity beyond
the 15-minute usage freshness limit; they never make old usage fresh. Ambiguous
accounts are left unknown. Samples and temporary sources remain bounded; pool
fingerprints are archived and pruned like account anchors after 14 days;
tracking is not reset.

No fixed Max-plan token price, cross-account capacity equivalence or guaranteed
weekly task count is inferred. Fit predictions require at least three completed
measurements on the same account/type and include observed variance and rounding
margin. Existing production caps, permissions and transaction locks remain final.

## Nachvollziehbare Mac-Präferenz

Der Reiter zeigt die Vorschau für den nächsten Pre-Gen-, Korrektur-, Übersetzungs-
oder Upload-Auftrag. `quota_routing.py` liest ausschließlich die bestehenden
Hub-Betriebsmeldungen und das aktivierte Reservierungsregister (`mode=ro`).
Exportiert werden nur Worker-ID, Zeit, Annahme, Plätze, aktive Aufgabenarten und
das optionale Feld `quota_slots` (Stand je Claude-Account des Macs: Platz,
Status, Messzeit, 5h- und Wochenfenster, laufende Arbeiten nur mit Art und
Startzeit), keine Aufgabentexte oder Zugangsdaten. `quota_slots` wird mit
derselben Form wie `validQuotaSlots` des Workers geprüft (ein bis zwei Plätze,
höchstens zwölf Läufe je Platz, Zeiten im ISO-Format); ein ungültiges Feld wird
verworfen, die Betriebsmeldung bleibt. Meldungen über 64 KiB werden weiterhin
übersprungen. Der begrenzte Snapshot wird mit der Verbrauchsübersicht etwa
minütlich erneuert. Fehlt das Register, gibt es keine scheinbar leere Last und
keine Empfehlung.

SQLite-WAL-Leser dürfen im Registerverzeichnis die Koordinationsdateien
initialisieren. Die Dienst-Sandbox bindet die Datenbank und eine vorhandene WAL
weiterhin schreibgeschützt ein; die Verbindung nutzt ausschließlich `mode=ro`.
Kein exklusiver Lock und kein `immutable`-Lesen einer laufenden Datenbank.

`team-server/distribution.js` verwendet das unveränderte Worker-Modul
`quota-pacing.js` (Provenienz: `team-server/vendor/README.md`). Aus den
Betriebsmeldungen (jede mit dem Max-Monitor-Stand des Macs als Rückfall) und den
aktiven Reservierungen entsteht mit `fleetMacs` und `analyseFleet` derselbe
Flottenstand wie beim Worker. Je Aufgabenart erhält jeder sichtbare Mac den
Schlüssel aus `macKey`: Last plus Vorsprung seines besten zulässigen Accounts vor
dem Wochentakt (Bürozeiten Mo–Fr 8–20 Uhr) und Nähe zu einem vollen 5h-Fenster,
in Aufgaben gerechnet (10 Prozentpunkte = eine Aufgabe). Bei gleichen Prozenten
zählt nur die Last: jeder Mac eine Aufgabe, dann zwei, dann drei. Kleinerer
Schlüssel heißt bevorzugt; innerhalb von 0,1 sind Macs gleichrangig.

Ausgeschlossen werden weiterhin Macs ohne frische Meldung, ohne Annahme, ohne
bekannte oder freie Plätze. Dazu kommen die Sperren des Workers je Account, die
nie überbrückt werden: „Account am Limit“ (`limited`), „5h-Fenster ausgelastet“
(`guard_5h`, Planung bis 90 % mit Reserve), „Wochenkontingent fast leer“
(`guard_weekly`), „Bremst: dem Takt voraus“ (`soft_cap`) und „Wartet: dem Takt
voraus“ (`paced`). Die Tabelle nennt den Grund, bei Macs mit zwei Accounts den
gewählten (Account 1 oder Account 2) und im Wochenfenster, wie viel laut Takt
jetzt frei sein sollte. Ohne aktuelle Kontingente gilt die bisherige absolute
Lastverteilung. Alte Restwerte bleiben mit Kennzeichnung sichtbar.

Die Vorschau reserviert keine Arbeit, simuliert keinen aufgabenspezifischen
Zugang, keine schon laufende Präferenz-Wartefrist und keine Wartezeit eines
freien Auftrags (die 60-Minuten-Lockerung des 5h-Plans und die 15-Minuten-Geduld
der Vorausstufe greifen erst beim Worker). Sales behält seinen
gesonderten Annahmeweg. Die Ansicht ersetzt keine Startfreigabe.
