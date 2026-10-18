# Verbrauch & Aufwand

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
Reset-Grenzen, Datenlücken über 30 Minuten und rückläufige Zähler werden nicht
als Verbrauch verrechnet. Die Rohauflösung beträgt derzeit einen Prozentpunkt.
Die Zuordnung zu parallelen Aufgaben erfolgt gleichmäßig je erfasstem
Assistenten-Antwortzug im jeweiligen Messintervall und ist ausdrücklich eine
Schätzung, keine gemessene Einzelaufgabenabrechnung. Unbeobachtete Privatnutzung
Ein gleichbleibender gerundeter Zähler bedeutet keinen belegten Nullverbrauch:
Antwortzüge bleiben bis zum nächsten ganzen Prozentpunkt gemeinsam offen und
werden erst dann auf die beteiligten Aufgaben verteilt. So entstehen aus vielen
kleinen Aufgaben keine künstlichen Nullwerte im Durchschnitt.
desselben Accounts kann enthalten sein. Es gibt keine angebliche Token-zu-Abo-
Umrechnung; Kapazitätsprognosen bleiben bis zur Kalibrierung deaktiviert.

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
- Vollständig gemessene Abschlüsse: Rohereignisse nach 30 Minuten verdichtet;
  unvollständige Abschlüsse spätestens nach zwei Tagen. Laufende Aufgaben behalten
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
