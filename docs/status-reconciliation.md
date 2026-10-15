# Automatischer Statusabgleich

Der bestehende `max-monitor-queue.service` gleicht die Quellen weiterhin jede
Minute ab. Er prüft zusätzlich beim Start und alle 30 Minuten den vollständig
veröffentlichten Stand durch erneutes Lesen der Fleet-API. Es gibt keinen zweiten
Statusschreiber, keine zusätzliche Worker-Aufgabe und keine KI-Abfrage.

## Audit vom 16.10.2026

728 Aufgaben wurden geprüft. Zwei abgeschlossene Uficell-Pre-Gen-Flows standen
fälschlich auf „Wartet“: Welcome (`12451cu7umh`) und Thank You (`12451cu7uu1`).
Eine alte portable Pausenreservierung setzte den aus ClickUp ermittelten
Abschluss zurück. Der Relay ließ den Wartet-Text außerdem vor der Prüfung des
nachgelagerten Review-Status passieren. Aktuelle Heartbeats konnten einen
abgeschlossenen Lauf unabhängig von seiner tatsächlichen Laufidentität öffnen.

Der unveränderte Live-Datenbestand wurde mit den korrigierten Regeln erneut
ausgewertet: 728 Aufgaben bleiben erhalten, nur diese zwei Status ändern sich,
keine widersprüchliche Anzeige bleibt im Replay übrig. Belege liegen unter
`docs/audits/2026-10-16-status-before.json` und
`docs/audits/2026-10-16-status-replay.json`.

## Verbindliche Regeln

- Eine spätere abgeschlossene Reservierung ersetzt alte aktive oder pausierte
  Reservierungen. Innerhalb des aktuellen Laufs bleibt die erste gültige
  Reservierung maßgeblich. Zurückgezogene Bewerber zählen nicht.
- Pre-Gen ist abgeschlossen, sobald ClickUp im nachfolgenden QA-, Review-,
  Korrektur- oder Upload-Schritt steht. Eine aktuelle Korrektur bleibt als eigene
  Aufgabe sichtbar. Der tatsächliche Status wird einschließlich `revision intern`
  und `revision extern` berücksichtigt.
- Eine portable Pause kann eine technische Blockade nur über den exakt passenden
  gespeicherten Hub-Fortsetzungsauftrag in „Wartet“ überführen.
- Ein neuer Auftrag darf wieder laufen. Er übernimmt weder Abschlussdatum noch
  Belege des früheren Versuchs. Ein neuer Heartbeat allein ist kein neuer Auftrag.
- Laufidentitäten werden auch für Pre-Gen, Übersetzung und Upload gespeichert.
  Ältere fremde Läufe können eine neuere gebundene Reservierung nicht verdrängen.
- Offene PM-Rückfragen bleiben gesperrt. Manuelle Entscheidungen bleiben erhalten.
  Historische Fehler werden nur dem passenden aktuellen Lauf zugeordnet.
- Dieselbe Zustandsregel gilt beim Erzeugen, Speichern, Anzeigen und Prüfen der
  Queue. Ein älterer Quellen-Snapshot wird mit HTTP 409 abgewiesen.
- Fehlt eine vollständige Quelle einschließlich des Fortsetzungsbestands, bleibt
  der bisherige gespeicherte Stand erhalten. Ein Teilabgleich gilt nicht als Erfolg.

## Halbstündlicher Kontrolllauf

Der Kontrolllauf verwirft beim Start seine Lese-Caches, verwendet den normalen
Quellenabgleich und liest dessen gespeichertes Ergebnis anschließend zurück.
Ein veralteter, fehlgeschlagener oder nur aus Rate-Limit-Fallbacks stammender
Quellenstand bestätigt keinen erfolgreichen Audit. Eine inzwischen neuere
Publikation wird nicht überschrieben. Bei Widersprüchen wird erneut geprüft und
der vorhandene Quellenstatus zeigt den konkreten Statusabgleich-Fehler.

Der Dienst schreibt im eigenen geschützten Cache-Verzeichnis:

- `/var/lib/max-monitor-queue/status-reconciliation.json`: letzter Kontrolllauf,
  Quellenzeitpunkt, geprüfte Aufgaben, behobene und offene Abweichungen.
- `/var/lib/max-monitor-queue/status-reconciliation.jsonl`: letzte 96 Kontrollen.

Systemd überwacht den bestehenden Dienst und startet ihn bei einem Fehler neu.
Nach einem Neustart findet sofort eine neue Kontrolle statt.

Der Abgleich schreibt ausschließlich Monitorzustände. Er ändert keine
ClickUp-PM-Status, Freigaben, Kommentare, Produktionsdateien oder Live-Mails.
`manuell`, Max-Monitor-Freigabe, Aufgabenmaximum und Draft bleiben verbindlich.

## Prüfung und Rollout

`node --test scripts/*.test.mjs team-server/test/*.test.js`: 306 Tests bestanden,
einschließlich der beiden realen Uficell-Fälle, alter/neuer Laufgenerationen,
PM-Sperren, manueller Entscheidungen, verlorener Quellen, veralteter Snapshots,
API-Rücklesen, Halb-Stunden-Takt und dauerhaftem Prüfprotokoll.

Die Ausrollung ändert nur die zentrale Queue-Bridge und den Relay samt gemeinsamem
Zustandsmodul und Kontrolllauf. Laufende Newsletter-Worker bleiben unberührt.
Vorher Runtime-Dateien sichern, anschließend frischen vollständigen Abgleich,
Audit-Protokoll, Fleet-API und die beiden Anzeigen im Max Monitor prüfen.

## Live bestätigt

Am 16.10.2026 um 00:56 Uhr wurde `c1fee17` im zentralen Dienst bestätigt.
Die öffentliche, authentifizierte Fleet-API und der gespeicherte Kontrolllauf
zeigen 729 aktuelle Einträge und keine offenen Statuswidersprüche. Beide
Uficell-Einträge stehen gespeichert auf `completed`. Der Max Monitor zeigt alle
sieben Uficell-Pre-Gen-Flows unter „Erledigt“ und keinen unter „Wartet“.
Ein vorheriger regulärer Folgeabgleich nach der ersten Ausrollung hatte die
Korrektur bereits erhalten. Der 30-Minuten-Takt ist im Scheduler-Test geprüft;
der erste produktive Kontrolllauf nach Dienststart ist gespeichert.

Beleg: `docs/audits/2026-10-16-status-live.json`. Die Runtime-Dateien und ihre
Vorgänger sind über das dort gespeicherte Release-Manifest rückverfolgbar.
