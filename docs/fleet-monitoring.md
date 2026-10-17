# Gemeinsame Mac- und Newsletter-Übersicht

Die gemeinsame Übersicht ist das Hauptfenster von Max Monitor. Ein Klick auf das
Menüleisten-Symbol oder erneutes Öffnen der App zeigt **Queue & Macs**; **Account Limits**
enthält die lokalen Konten und ihre Limits im selben Fenster. Konten werden dort über
**Konten verwalten** hinzugefügt. Team-ID, persönlicher Token und Worker-ID liegen unter
**Einstellungen → Verbindung & Worker**. Beim Tabwechsel bleiben die Queue-Filter erhalten.

**Queue & Macs → Monitoring-Account** verbindet genau einen Claude-Account für den
lokalen Mac. Dieser Login und seine gespeicherten Zugangsdaten sind unabhängig von
**Account Limits**. Konten in Account Limits werden niemals automatisch als
Monitoring-Account übernommen. Jede Mac-Karte nennt den verbundenen Account;
ohne Verbindung bleiben die Limits unbekannt, während der Gerätebericht weiterläuft.
Die Werte **5h** und **Woche** stammen jeweils aus dem Fünf-Stunden-Limit und dem
gesamten Wochenlimit dieses Accounts. Einzelne Modelllimits stehen in den Details.

Unter **Mitglieder → MacWorker** bestimmt der Inhaber unabhängig von der Rolle,
welche Zugänge Geräteberichte senden und als Macs in der Übersicht erscheinen.
Das gilt auch für Admins, Gäste und die Inhaber-Zeile. Die Rolle und ihre
Zugriffsrechte bleiben erhalten. Bestehende Mitglieder und automatisch registrierte
Worker sind beim Upgrade aktiviert; andere Zugänge zunächst deaktiviert.
Eine laufende App übernimmt Änderungen innerhalb einer Minute. Ausschalten
blendet Geräte und Kontingente aus und sperrt weitere Meldungen, ohne die
gespeicherten Daten zu löschen. Erneutes Einschalten stellt die Ansicht wieder her.

Alle Macs verbinden sich mit **demselben Team-Relay und derselben Team-ID**. Das
Repository verteilt den Programmcode; das Relay speichert die gemeinsamen Daten.
Damit hängt die Übersicht nicht von Tills Arbeits-Mac ab. Das Relay läuft auf einem
VPS oder Railway mit persistentem Volume; jeder Mac sendet seinen eigenen Bericht
und liest die gemeinsame Fleet- und Aufgabenübersicht.

```text
Mac 1: Claude-Konto 1 + Gerätebericht ─┐
Mac 2: Claude-Konto 2 + Gerätebericht ─┼── HTTPS ── Team-Relay ── alle Max-Monitor-Apps
Mac 3: Claude-Konto 3 + Gerätebericht ─┘                  ↑
                                                       │ Queue-Snapshot
ClickUp-Startstatus + RS-Hub-Reservierungen + Hub-Worker-Dateien ── Newsletter-Bridge
```

Die **Übersicht** zeigt alles auf einer Seite: oben pro Workflow ein Balkendiagramm
der Stufen **Markiert · Wartet · Läuft · Blockiert · Fertig** (bei Bedarf **Fehler**),
daneben die dringendsten Einträge aus **Braucht Aufmerksamkeit** und darunter alle Macs
mit Status, aktueller Aufgabe, Akku, 5h-/Wochenlimit und letzter Meldung. Wie bei
den Workern erteilt nur der ClickUp-Status einen Auftrag (`pre-gen`, `klaviyo upload`,
`revision intern`, `revision extern`); die Brücke liest diese Aufgaben mit derselben
Statusabfrage und demselben Statusbeginn wie der Worker. Lehnt ClickUp den
Statusbeginn einer Aufgabe ab (HTTP 4xx außer 429), wartet wie beim Worker nur diese
Aufgabe: Sie erscheint ohne Statusbeginn als „Statusbeginn nicht lesbar (HTTP …) ·
wird nicht reserviert“, die Quelle nennt ihre Anzahl, und die Brücke fragt sie erst
nach 15 Minuten erneut ab. Nur 429, 5xx und Übertragungsfehler lassen den ganzen
Abgleich scheitern; dann bleibt die letzte Queue erhalten. „Markiert“ heißt: Der Status
ist gesetzt, aber noch kein Status-Tag; `pre gen · wartet` oder eine Reservierung
zählt als „Wartet“. Warte- oder Lauf-Tags außerhalb dieses Status sind kein Auftrag
und erscheinen nicht als offen; Blockaden und Abschlüsse bleiben sichtbar. Aufträge,
die der Worker nicht annimmt, erscheinen nicht als wartend; die Brücke prüft sie mit
den Regeln des Workers aus `--worker-root`: ein vom PM gesetztes `manuell`, Pop-ups in
`revision intern`, `revision extern` und `klaviyo upload`, Aufgaben der Testumgebung
außerhalb eines gültigen Pre-Gen und Altbestand aus `config/workflow-cutover.json` mit
unverändertem Statusbeginn. Die Prinz-Upload-Marke (`manuell` auf einem Ordner aus
`config/manual-uploads.json`) bindet nur den Upload; spätere Korrekturen und
Pre-Gen-Aufträge erscheinen normal (docs/ablauf.md, Till 16.10.2026). Die Quelle nennt
die Zahl geparkter Aufträge; reservierte Läufe, Blockaden und Abschlüsse bleiben
sichtbar. Fehlen diese Dateien in einer älteren Quellinstallation, parkt wie bisher
nur der Tag `manuell`. Ein Klick auf einen
Balken öffnet die Queue mit genau diesem Status- und Workflow-Filter. Das Dashboard ist
bewusst immer hell, auch im macOS-Dunkelmodus.

Im **Queue-Log → Braucht Aufmerksamkeit** stehen die aktuell betroffenen Macs und
blockierten oder fehlgeschlagenen Aufgaben mit ihren Gründen und Details. „Im Log
ansehen“ in der Übersicht und die Zahl am Log-Reiter öffnen diesen Filter direkt. Jeder Mac und jede Aufgabe
zählt einmal, auch wenn mehrere Gründe vorliegen; gelöste Einträge verschwinden
beim nächsten Abgleich. **Alle Ereignisse** zeigt weiterhin die Historie.

## Einheitliche Mac-Bezeichnungen

Slack zeigt die `worker_id` aus der Newsletter-Konfiguration. Genau diese Kennung
ist auch der Hauptname in der Mac-Übersicht, der Aufgaben-Queue und dem Q-Log,
einschließlich älterer Geräte-Ereignisse. Der macOS-Gerätename bleibt als
Zusatzinformation unter dem Hauptnamen der Mac-Karten, als Tooltip in der Übersicht
und in den Details sichtbar; die Suche findet beide. Eine Umbenennung in macOS ändert die Zuordnung nicht.

Bei einem Mac ohne Worker-ID wird dessen gemeldeter Gerätename angezeigt und die
fehlende Zuordnung ausdrücklich kenntlich gemacht. Namen werden nie anhand eines
ähnlichen Hostnamens oder einer IP-Adresse automatisch anderen Macs zugeordnet.

Ausnahme mit Nachweis: Der Newsletter-Worker liest auf seinem eigenen Mac die
zufällige Geräte-UUID der App (`fleetDeviceId`) und sendet sie bei jeder
Freigabeprüfung (etwa jede Minute) mit. Hat genau diese App keine eigene Worker-ID
und trägt kein anderer Mac die Worker-ID, zeigt das Relay den Mac unter der
Worker-ID an, samt seiner angenommenen Aufgaben und dem Worker-Status; die Details
nennen die Quelle „vom Newsletter-Worker auf diesem Mac gemeldet“. Die
Zuordnung dient nur der Anzeige: Die Freigabe neuer Aufgaben nutzt weiter nur die
Identitäten, die App und Registrierung selbst gemeldet haben. Eine in der App
eingetragene Worker-ID hat immer Vorrang; meldet der Worker eine andere App, wandert
die Zuordnung mit.
Historische Aufgaben behalten den damals zuständigen Worker, auch nach einer
Neuzuweisung oder Freigabe.

## Suche und Aufgabenlinks

Die Aufgaben-Queue durchsucht Titel und Aufgaben-ID, Unternehmen, Mac-Namen und
Worker-ID sowie den vollständigen ClickUp-Link. Status- und Workflow-Filter gelten
weiterhin für die Treffer. Das Unternehmen erscheint unter dem Aufgabentitel und
stammt aus dem sichtbaren ClickUp-Kundenordner.

Rechts öffnen die kleinen Links ClickUp und das Figma-Board in einem neuen Fenster.
Die Brücke bevorzugt den direkten `Figma Pre-Gen`-Link, danach `Figma Link` bzw.
ein Figma-Board-URL-Feld der Aufgabe. Ohne Aufgabenlink öffnet Pre-Gen das Testboard
aus `PRE_GEN_FILE` der eingerichteten Newsletter-Quelle. Für Uploads ohne Figma-Link
wird kein Board geraten. Alte Aufgaben ohne diese optionalen Angaben bleiben nutzbar.

## Tageszahlen und Abschlussbelege

Die Pipeline zeigt unter **Offen + heute fertig** sämtliche aktuell offenen
Aufträge und ausschließlich belegte Abschlüsse des aktuellen Berliner Kalendertags.
Ein Klick auf einen Balken verwendet denselben Zeitraum und dieselbe Auftragsart
in der Queue. **Gesamt** enthält zusätzlich die historischen erledigten Aufträge.
Newsletter, Flows und Pop-ups werden je Workflow getrennt angezeigt und gefiltert.

Automatische Abschlüsse verwenden den gespeicherten erfolgreichen Slack-Auftragsabschluss;
manuell abgehakte Aufgaben ihren bestätigten Monitor-Abschluss. Spätere Änderungen
in ClickUp verschieben keinen Abschluss in einen anderen Tag. Ein neuer laufender
oder fehlgeschlagener Versuch übernimmt keinen Erfolgsbeleg seines Vorgängers.
Review-Übergaben und Fertig-Tags ohne Erfolgsbeleg bleiben mit ihrer Herkunft und
**unbekanntem Abschlussdatum** sichtbar, zählen aber nicht als heute fertig.
Übersicht, Queue, Aufgaben-Details und mobile Zeilen verwenden diese Angaben
übereinstimmend. Die Gesamtzusammenfassung nennt manuelle Erledigungen und fehlende
Abschlussdaten gesondert.

## Live-Abgleich

Die zentrale Newsletter-Brücke liest ClickUp-Aufgaben und die tatsächlichen
Worker-Reservierungen aus Slack alle 60 Sekunden. Der Abstand gilt zwischen den
Starts der Abfragen; deren Laufzeit wird nicht zusätzlich als Wartezeit addiert.
ClickUp, Reservierungen und Hub-Gerätemeldungen werden parallel gelesen. Dauert
eine Quelle länger oder fällt sie aus, bleibt der letzte vollständige Stand
sichtbar; unvollständige Quellenantworten überschreiben weder Aufgaben noch
Zuordnungen.

Die Brücke nutzt denselben Slack-Zugang (Tuck) wie alle Worker-Macs und hält
ihren Leseanteil deshalb klein: Reservierungskanäle werden seitenweise mit 999
Nachrichten und höchstens alle 180 Sekunden vollständig gelesen; dazwischen
zeigt die Queue diesen Stand. Antwortet Slack für einen Kanal mit 429, nutzt die
Brücke dessen letzten vollständigen Stand, solange er jünger als zehn Minuten
ist, statt den ganzen Abgleich zu verwerfen. Ein solcher Stand dient nur der
Anzeige; Reservierungen treffen ausschließlich die Worker mit eigenen Lesungen,
und die Bereinigung der Fehlerkopien läuft nur nach einem vollständig frisch
gelesenen Abgleich. Ob die Reservierungskanäle neu gelesen werden, entscheidet
die Brücke je Abgleich für alle gemeinsam: Fehlt ein Kanal, ist sein Stand
älter als 180 Sekunden oder stammt er aus einem 429-Ersatz bzw. einer
fehlgeschlagenen Lesung, liest sie im selben Abgleich alle Kanäle neu. So
kommt nach einem einzelnen 429 oder Übertragungsfehler spätestens im nächsten
Abgleich wieder ein vollständig frischer Stand zustande, statt dass die Kanäle
dauerhaft in getrennten Takten gelesen werden. Trifft ein solcher Abgleich
erneut auf 429, nutzen die übrigen Kanäle ihren eigenen Zwischenstand.

Sobald ein vollständiger Stand im Relay gespeichert wurde, meldet eine
authentifizierte Live-Verbindung die Änderung an alle offenen Monitor-Fenster.
Diese laden die aktuelle Queue unmittelbar nach und behalten ihre Filter. Das
gilt für neue Aufgaben, Übernahmen, Mac-Wechsel, Freigaben und Abschlüsse.
**Live** zeigt eine aktive Verbindung; **Abgleich** den regelmäßigen Abruf als
Fallback. Nach Unterbrechung oder Aufwachen verbindet sich die Ansicht erneut.
Der Fallback prüft alle 30 Sekunden. Tokens bleiben ausschließlich im
Authorization-Header, niemals in einer Stream-URL oder im Browser-Speicher.

Änderungen in ClickUp/Slack werden beim nächsten Quellenabgleich erkannt; es
werden keine direkten ClickUp-Webhooks vorausgesetzt. Die Quellenlaufzeit und
Verfügbarkeit bestimmen die tatsächliche Verzögerung. Geräte- und
Account-Heartbeats laufen unabhängig davon im Minuten-Takt.

Zusätzlich meldet ein eigener LaunchAgent auf jedem Worker alle 15 Sekunden den
lokalen Worker-Dienst, seine tatsächlich offenen Läufe und den letzten Poll direkt
an den bestehenden RS Hub. Die Anzeige verwirft diese Aktivitätsmessung nach 45
Sekunden. „frei“ setzt einen laufenden Dienst, keine offenen Läufe und einen frischen
Poll voraus; ohne Nachweis steht „Tätigkeit ungeprüft“. Pausierte Annahme wird
gesondert gezeigt.

**Plätze** zeigt die belegten Plätze gegen das Maximum des Macs (Tabelle in
`AGENTS.md` des Worker-Repos), genau so, wie der Worker sie für die Annahme zählt:
reservierte und laufende Läufe beider Arbeitsbereiche, Sales-Aufträge,
Klaviyo-Browser-Aufträge, Vorschauen und Korrektur-Übertragungen. Pausierte Aufgaben
warten außerhalb der Plätze. Quelle ist die frischere Worker-Meldung: der direkte
Bericht (`activity.occupiedTasks`/`maxTasks`, 45 s gültig) oder der Hub-Herzschlag
(`occupied_tasks`/`max_tasks`, 180 s gültig). Sendet ein älterer Worker kein Maximum,
nimmt die Brücke es aus der Worker-Tabelle der installierten Newsletter-Quelle. Ein
voller Mac heißt „voll belegt · 3 / 3“ statt „Annahme pausiert“; belegte Plätze ohne
Queue-Zeile (z. B. ein Browser-Auftrag) zeigen „belegt · 1 / 6“. Der Wartungsdienst prüft alle 60 Sekunden mit dem vorhandenen
Worker-Wächter; launchd startet einen beendeten Beobachter erneut. Aktive Läufe
werden dafür nicht beendet. Claude-Kontingente werden alle fünf Minuten geprüft;
Fehler führen zu gestaffelten Wiederholungen, statt den Account zurückzusetzen.

Reservierungen kommen auf dem Hub (`--local-hub`) aus dem RS-Hub-Reservierungsregister
(`<HUB_RUNTIME_DIR>/state/worker-reservations/claims.sqlite`, nur lesend), aus dem
auch die Worker ihre Aufträge annehmen. Das Register entscheidet Mac, Zustand und
Pause; Slack liefert nur noch den Thread für Fortschritt und Blockiergrund, seine
Reaktionen und den Zeitpunkt eines Abschlusses. Ist das Register nicht lesbar, zeigt
die Quelle das an und die Slack-Kopie der Reservierungen hält die Queue sichtbar.

Korrekturen erscheinen unabhängig vom alten Pre-Gen-Abschluss. Jede Aufgabe in
`revision intern`/`revision extern` ist eine Korrektur mit der Worker-Kennung
`korrektur-cu-<ID>@<Statusbeginn>-<intern|extern>`, auch ohne Reservierung; eine
Reservierung derselben Runde (auch je Datei) ersetzt diese Zeile, ältere Runden
verdecken eine neue nie. Die aktuellen
Reservierungen werden etwa alle drei Minuten neu gelesen: ❌ am finalen Claim bedeutet
blockiert, ✅ abgeschlossen. Die eigene Bot-Antwort liefert den Blockiergrund. Er
bleibt samt zuständigem Mac sichtbar, auch wenn dieser bereits andere Aufgaben
bearbeitet. Ein neuer Versuch ersetzt die alte Blockierung; freigegebene oder
zurückgezogene Versuche werden nicht als offene Korrektur gezählt. Die Queue
unterscheidet Vorbereitung und Mail-Korrektur, ihre Statuszahlen berücksichtigen
Workflow, Mac und Suche. Mac-Karten und Details nennen die blockierten Korrekturen,
ohne sie als noch laufende Prozesse zu zählen.

## Fortschritt und Entwurf laufender Newsletter

Für jede laufende Aufgabe liest die Brücke die Status-Antwort des Workers im
Slack-Thread seiner Reservierung (`⏳ 50 % · Bau der Mail`, vom Worker alle fünf
Minuten bearbeitet). Prozent und Schritt erscheinen im Fortschrittsbalken und als
„Letzter Schritt“. Der Schritt steht im eigenen Feld `step`; anders als `phase`
erzeugt er keinen Log-Eintrag und ändert die Abhak-Version nicht. Ohne lesbare
Status-Antwort bleibt die Aufgabe einfach „In Bearbeitung“. Ein Thread wird nur
erneut gelesen, wenn sich der Heartbeat seiner Reservierung geändert hat oder
der gemerkte Stand fünf Minuten alt ist. Nach dem ersten 429 eines Abgleichs
liest die Brücke keine weiteren Threads; diese behalten ihren letzten Stand.

Jeder Bau einer Mail (`build.py --kunde`) speichert das tatsächliche Render im RS
Hub, auch das erste vor dem Art Director. Die Brücke auf dem Hub liest diese
Renders schreibgeschützt aus `/opt/rs-hub/data/customer-intelligence.sqlite`:
Nachrichten mit `external_id` `clickup:<Aufgabe>:<master|mail-N>`, davon die
Ergebnisse mit `metadata.attemptId` = `run_id` der Slack-Reservierung. Pro Mail
wird das neueste Render mit dem vorhandenen `sharp` auf 600 px Breite als JPEG
verkleinert, einmal per `PUT /v1/teams/:id/fleet/previews/<sha256>` an das Relay
geschickt und im Snapshot nur als Verweis (`previews`) geführt. Hat eine Aufgabe
Entwürfe, steht unter ihrem Namen „· 14 Entwürfe“; ein Klick auf den Namen öffnet
die Mail in echter Breite, bei Flows mit Mail-Auswahl (ClickUp und Figma bleiben
rechts in den Aktionen);
ein neues Render ersetzt sie beim nächsten Abgleich, ohne Auswahl oder
Scrollposition zu verlieren. Nach dem Abschluss bleibt der letzte Entwurf bis zu
sieben Tage sichtbar; Aufgaben, die vor dieser Funktion fertig waren, bekommen
keine nachträglichen Bilder. Das Relay löscht Bilder, die keine Aufgabe mehr
verwendet, nach einer Stunde. Eine Mac-Brücke ohne `--local-hub` liefert keine
Entwürfe.

## Automatische Einrichtung neuer Worker

Der neue-Mac-Startbefehl von **AI Newsletter Creation** klont auch Max-Monitor,
baut die App, installiert sie unter `~/Applications/Max Monitor.app` und verbindet
sie über den bereits freigeschalteten Hub-Zugang. Dasselbe vollständige Setup
startet `RS-Skills/install.sh --worker-mac`. Die Worker-ID stammt aus der eigenen
Newsletter-Konfiguration; Server-Adresse, Team-ID und ein eigener Member-Token
kommen automatisch vom zentralen Hub. Ein wiederholter Lauf prüft die bestehende
Verbindung und legt keine weiteren Mitglieder an.

Auf einem bereits eingerichteten Worker reicht:

```bash
cd ~/Documents/"AI Newsletter Creation"
bash ops/macos/max-monitor.sh
```

Mit `--check` lässt sich die Verbindung ohne Installation oder neue Anmeldung
prüfen, mit `--dry-run` der Ablauf ansehen. Die App startet beim Anmelden, sofern
macOS den Autostart freigibt. Das eigene Claude-Konto meldest du einmal auf dem
jeweiligen Mac über **Queue & Macs → Monitoring-Account** an. Auch nach einem
Upgrade von einer älteren App ist dieser separate Login erforderlich;
bisherige Konten in **Account Limits** bleiben dort erhalten.
macOS-Dialoge lassen sich ohne Geräteverwaltung nicht
vorab bestätigen.

Die zentrale Einrichtung erfolgt einmal nach
[dieser Hub-Anleitung](hub-installation.md). Der
[Enrollment-Vertrag](worker-enrollment.md) beschreibt Token und Gerätebindung.
Es läuft nur eine zentrale Queue-Bridge; auf neuen Macs ist keine weitere
Bridge erforderlich.

## Manuelle Einrichtung

1. Das aktualisierte `team-server` auf dem gemeinsamen Server bereitstellen. Ein
   dauerhaftes `/data`-Volume und ein eigener `TEAM_TOKENS`-Eintrag für das Team
   sind erforderlich. Die Anleitung steht in [team-server/README.md](../team-server/README.md).
2. Im Max Monitor als Team-Owner für **jeden Mac einen eigenen Member** anlegen.
   Relay-URL und Team-ID sind auf allen Macs gleich; der Member-Token ist pro Mac
   verschieden. Den Super-Token beim Owner belassen. Die App benötigt weder
   ClickUp-Zugangsdaten noch das Claude-Konto eines anderen Macs.
3. Den Zugang unter **Mitglieder → MacWorker** aktivieren und auf jedem Mac dessen eigenes Claude-Konto über **Queue & Macs → Monitoring-Account** verbinden. Nach der
   Team-Verbindung sendet die App automatisch den Gerätebericht. Akku,
   Stromversorgung, Gerät und Usage-Werte stammen von diesem Mac. Der regelmäßige
   Bericht wird jede Minute gesendet, außerdem beim Start und nach dem
   Aufwachen.
   Unter **Einstellungen → Allgemein** „Beim Anmelden starten“ einschalten,
   damit die Meldung nach einem Neustart wieder läuft. Die App muss geöffnet sein;
   ein schlafender oder ausgeschalteter Mac kann keine aktuellen Werte senden.
4. Die **Worker-ID** in Max Monitor identisch zu
   `AI Newsletter Creation/config/worker.local.json` → `worker_id` setzen.
   Beispielsweise `newsletter-mac-1`, `newsletter-mac-2`, `newsletter-mac-3`.
   Auch die Newsletter-Worker-Konfiguration braucht einen eindeutigen Wert.
   Der automatische Hostname kann im Büronetz bei mehreren Macs `macbookair`
   ergeben und eignet sich deshalb nicht als gemeinsame Zuordnung.
5. Eine Newsletter-Bridge für das Team dauerhaft ausführen. Am besten läuft sie
   auf dem gemeinsamen RS Hub/VPS; sie benötigt den vorhandenen autorisierten
   Hub-Transport und einen Checkout des Newsletter-Workers. Sie kann separat vom
   eigentlichen Newsletter-Service laufen und startet keine Newsletter-Aufgaben.

Ein alter Gerätebericht bedeutet **keine aktuelle Messung**. Ein ausgeschalteter,
schlafender oder vom Netz getrennter Mac kann keinen neuen Bericht schicken. Die
Übersicht zeigt deshalb den letzten Empfang und markiert ausbleibende Meldungen;
fehlende Akku- oder Claude-Werte bleiben unbekannt. Nach dem nächsten Bericht
wird der Zustand automatisch aktualisiert.

## Newsletter-Bridge starten

Die Bridge benötigt Node 20 oder neuer, den vorhandenen Newsletter-Checkout mit
`config/worker.local.json`, dessen SSH-Key und geprüfte `hub_known_hosts`. Sie
importiert ausschließlich die Konfiguration und den bestehenden RS-Hub-Transport.
ClickUp- und Slack-Schlüssel verbleiben auf dem Hub. Auf einem neuen Bridge-Host
muss der Hub-Zugang zuerst über den vorhandenen Team-Setup-Prozess eingerichtet
werden; private SSH-Keys werden nicht aus einem anderen Mac kopiert oder im Repo
abgelegt.

Zuerst die Quelle ohne Relay-Schreibzugriff prüfen:

```bash
node scripts/newsletter-monitor-bridge.mjs \
  --worker-root "/Pfad/zu/AI Newsletter Creation" --dry-run
```

Die Ausgabe ist ein vollständiger Snapshot mit Aufgaben, Quelle und beobachteten
Workern. `--dry-run` schreibt weder in das Relay noch in den lokalen Cache. Auch
ClickUp, Slack und die vorhandenen Hub-Dateien werden nur gelesen.

Für den laufenden Abgleich sind vier Umgebungsvariablen erforderlich:

| Variable | Bedeutung |
| --- | --- |
| `NEWSLETTER_WORKER_ROOT` | Absoluter Pfad zum Newsletter-Checkout |
| `MONITOR_RELAY_URL` | Gemeinsame HTTPS-Relay-URL |
| `MONITOR_TEAM_ID` | Gemeinsame Team-ID |
| `MONITOR_BRIDGE_TOKEN` | Eigener Admin-Token oder Super-Token für die Queue-Übernahme |

Der Token wird ausschließlich über die Prozessumgebung übergeben, niemals als
CLI-Argument. Ein eigener Admin für die Bridge erleichtert das spätere Widerrufen.
Auf macOS kann ein lokales Startskript den Token aus dem Schlüsselbund beziehen:

```bash
#!/bin/zsh
set -eu
export NEWSLETTER_WORKER_ROOT="/Pfad/zu/AI Newsletter Creation"
export MONITOR_RELAY_URL="https://monitor.example.com"
export MONITOR_TEAM_ID="DEMO1234"
export MONITOR_BRIDGE_TOKEN="$(security find-generic-password -w \
  -s 'MaxMonitor Newsletter Bridge' -a "$MONITOR_TEAM_ID")"
exec /absoluter/pfad/zu/node "/Pfad/zu/Max-Monitor/scripts/newsletter-monitor-bridge.mjs"
```

Den Schlüsselbund-Eintrag einmal lokal in „Schlüsselbundverwaltung“ anlegen. Auf
einem VPS stellt ein Service-Manager die Umgebung aus einer geschützten Datei oder
einem Secret Store bereit. Nur **eine Bridge pro Team** als Queue-Produzent betreiben.

Für macOS ist ein Installer enthalten. Vor dem Aufruf `NEWSLETTER_WORKER_ROOT`,
`MONITOR_RELAY_URL` und `MONITOR_TEAM_ID` setzen; optional `MONITOR_NODE_PATH` für
einen Node-Pfad, der ohne Shell-Profil verfügbar ist. Der Installer benötigt
keinen `MONITOR_BRIDGE_TOKEN` in seiner Umgebung.

```bash
# Konfiguration und vorhandenen Schlüsselbund-Eintrag ohne Änderung prüfen:
scripts/install-newsletter-monitor.sh --check

# Dienstdateien ausschließlich in einem Testverzeichnis erzeugen, nicht laden:
scripts/install-newsletter-monitor.sh --generate-only --output-dir /tmp/max-monitor-bridge-preview

# Installieren und starten (nur auf dem einen gewählten Bridge-Host):
scripts/install-newsletter-monitor.sh

# Dienst später stoppen und entfernen; Schlüsselbund und Queue behalten:
scripts/install-newsletter-monitor.sh --uninstall
```

Der Benutzer-LaunchAgent heißt `de.max-monitor.newsletter-bridge.<TEAM-ID>`. Er
läuft nach der Anmeldung (`RunAtLoad`) und alle 60 Sekunden (`StartInterval`),
jeweils als begrenzter `--once`-Aufruf. `MONITOR_BRIDGE_INTERVAL_SECONDS` ändert
das Intervall. Launchd startet keine zweite Instanz derselben laufenden Aufgabe.
Die Dateien liegen unter `~/Library/LaunchAgents/` und
`~/Library/Application Support/Max Monitor/Newsletter Bridge/<TEAM-ID>/`.
Die generierte plist enthält keinen Token; das Startskript liest ihn bei jeder
Ausführung aus dem Schlüsselbund. Absolute Pfade und Dateirechte `0600`/`0700`
schützen die Konfiguration. Der Installer führt keine Newsletter-Jobs aus.

```bash
# Einmalige Übernahme, wenn die Umgebung eingerichtet ist:
node scripts/newsletter-monitor-bridge.mjs --once

# Dauerhafter Abgleich, Standardintervall 60 Sekunden:
node scripts/newsletter-monitor-bridge.mjs

# Andere Workflows und anderes Intervall:
node scripts/newsletter-monitor-bridge.mjs --workflows /geschuetzt/workflows.json --interval 120

# Adapter-Prüfungen ohne Netz oder Tokens:
node --test scripts/newsletter-monitor-bridge.test.mjs
```

Optional: `MONITOR_WORKFLOWS_FILE`, `MONITOR_BRIDGE_INTERVAL_SECONDS`,
`MONITOR_HUB_FLEET_DIRECTORY` und `MONITOR_BRIDGE_CACHE` setzen dieselben Werte
wie die entsprechenden CLI-Parameter.
Der Cache liegt standardmäßig unter `~/.cache/max-monitor/newsletter-bridge.json`
mit Dateirechten `0600`. Er wird erst nach einer bestätigten Relay-Übernahme
aktualisiert. Aufgabenüberschriften stehen in diesem Cache; Briefings und
Provider-Zugangsdaten werden nicht übertragen.

## Aufgaben, Uploads und weitere Workflows

Die Bridge liest alle Spaces des ClickUp-Workspaces und entdeckt die tatsächlich
vorhandenen Tag-Schreibweisen. Sie fragt anschließend alle Seiten der passenden
Aufgaben einschließlich Subtasks ab. `include_closed=false` lässt geschlossene
ClickUp-Aufgaben aus. Abgeschlossene Pre-Gen-Schritte einer weiterhin offenen
ClickUp-Aufgabe bleiben als `completed` sichtbar.

Standardmäßig werden diese Workflows erkannt:

| Workflow | Auftrag / historische Tags | Status-Tags |
| --- | --- | --- |
| `newsletter` (Pre-Gen) | Status `pre-gen`; Tags nur für Fortschritt und Historie | `pre gen · wartet`, `pre gen · läuft`, `pre gen · pausiert`, `pre gen · blockiert`, `pre gen · fertig` |
| `upload` (Klaviyo-Upload) | Status `klaviyo upload`; Tags nur für Fortschritt und Historie | `klaviyo upload · wartet`, `klaviyo upload · läuft`, `klaviyo upload · blockiert`, `klaviyo upload · fertig` |
| `translation-en` … `translation-sp` (Übersetzung) | Alte Sprach-Tags erzeugen keinen Auftrag; aktive oder pausierte Reservierungen bleiben sichtbar | `<sprache> translation · blockiert`, `<sprache> translation · fertig` |

Die Tags entsprechen genau denen des Newsletter-Workers (`AI Newsletter Creation`,
`src/pre-gen.js`). Übersetzungen erscheinen je Sprache als eigene Zeile mit dem
Workflow `translation` und dem Sprachkürzel am Titel, z. B. „Graco Aktion · EN“.
Wartende Sprachfassungen eines laufenden Sprachpakets erscheinen im Dashboard
unter **Läuft** mit „Paket läuft“. Die Zuordnung nutzt dieselbe ClickUp-Aufgabe
oder einen eindeutigen Briefing-Link zur DE-Aufgabe desselben Kunden. Status und
Worker-Plätze der einzelnen Fassung bleiben erhalten; Blockaden, Pausen und
PM-Rückfragen bleiben in ihrer bisherigen Ansicht.
Unreservierte alte Übersetzungs-Tags erzeugen keine wartende Zeile, auch wenn die
Sprachfassung eine eigene ClickUp-ID hat. Abgeschlossene und blockierte
Übersetzungen bleiben als Historie erhalten.
Offene PM-Fragen des aktuellen Versuchs erscheinen auch nach zentraler Sicherung
als „Wartet · PM-Rückfrage“, ohne einen Platz auf dem ursprünglichen Mac zu belegen.
Groß-/Kleinschreibung, Leerzeichen und Satzzeichen werden beim Abgleich
normalisiert; ClickUp-Abfragen verwenden trotzdem die genaue vorhandene
Schreibweise. Alle Tags werden in **einer** seitenweisen ClickUp-Abfrage gelesen
(mehrere `tags[]` verknüpft ClickUp mit ODER); das hält den minütlichen Abgleich
deutlich unter dem Limit des gemeinsamen Hub-Schlüssels. Die Bridge führt selbst
keine Uploads oder Übersetzungen aus.

Sales-Jobs werden im zentralen Hub-Modus aus `sales-newsletter/<Slack-ts>/job.json`
gelesen, einschließlich HTTP-Shopadressen. `reserved` erscheint als Wartet,
`running` und `delivery` als Läuft, `blocked` als Blockiert,
`done` als Fertig mit 100 %. Abgebrochene Versuche (`aborted`) werden nicht
angezeigt und zählen zu keiner Statusgruppe. Blockiergründe und
der aktuelle Versuch bleiben zugeordnet. Eine verspätete Worker-Meldung entfernt
keinen Auftrag; nach 30 Minuten erscheint „Worker-Meldung ausstehend“, bis der
Hub einen neuen Jobstatus speichert. Nicht lesbare oder unvollständige Sales-Daten
melden einen Quellenfehler und behalten die letzte vollständige Queue im Relay
und Cache. Abgeschlossene Jobs haben kein zeitliches Ablaufdatum.

Weitere Workflows kommen über eine JSON-Datei hinzu:

```json
[
  {
    "id": "newsletter",
    "triggerTags": ["pre gen."],
    "claimWorkflow": "newsletter",
    "stateTags": {
      "queued": ["pre gen · wartet"],
      "running": ["pre gen · läuft"],
      "blocked": ["pre gen · blockiert"],
      "completed": ["pre gen · fertig"]
    }
  },
  {
    "id": "upload",
    "triggerTags": ["klaviyo upload"],
    "claimWorkflow": "klaviyo",
    "stateTags": {
      "queued": ["klaviyo upload · wartet"],
      "running": ["klaviyo upload · läuft"],
      "blocked": ["klaviyo upload · blockiert"],
      "completed": ["klaviyo upload · fertig"]
    }
  },
  {
    "id": "correction",
    "triggerTags": ["ai correction"],
    "stateTags": {
      "running": ["ai correction · läuft"],
      "blocked": ["ai correction · blockiert"],
      "completed": ["ai correction · fertig"]
    }
  }
]
```

Eine eigene Datei **ersetzt** die Standardliste. Ein ClickUp-Task mit mehreren
Workflow-Tags erzeugt je Workflow eine Zeile, beispielsweise
`clickup:newsletter:86abc123` und `clickup:upload:86abc123`.

Worker-Zuordnungen stammen aus den Slack-Metadaten im bestehenden Kanal
`#ai-pre-gen-status`, nicht aus dem Nachrichtentext. Die Events enthalten
`task_id`, `run_id`, `worker`, `state` und den Herzschlag in Unix-Sekunden. Je
Auftragsart gibt es ein eigenes Event mit eigener Auftragskennung:
`ai_newsletter_claim` (`<ClickUp-ID>`, Workflow `newsletter`),
`ai_klaviyo_upload_claim` (`<ClickUp-ID>-klaviyo`, `claimWorkflow` `klaviyo`) und
`ai_translation_claim` (`<ClickUp-ID>-uebersetzung-<sprache>`, `translation-<sprache>`).
Passen Event und Kennung nicht zusammen, wird die Reservierung wie im Worker
ignoriert. Eine frische Reservierung im Zustand `claiming` erscheint als
„Reserviert“ und zählt beim Mac bereits als angenommene Aufgabe.
Aktive Reservierungen werden nach der im Worker konfigurierten Stale-Frist
(Standard 30 Minuten) als blockiert angezeigt („Worker meldet sich nicht mehr“).
Meldet derselbe Mac seinen eigenen Herzschlag noch frisch an den RS Hub (höchstens
180 Sekunden alt), hängt nur die Reservierungsmeldung nach: Die Aufgabe wartet dann
als „Wartet · Mac aktiv, Reservierungsmeldung an den RS Hub verzögert“ und ist nicht
blockiert. Meldet derselbe Mac den Lauf in seinem eigenen frischen Live-Bericht
nicht, widersprechen sich Mac und Reservierung; die Aufgabe zeigt dann
„Worker-Abgleich ausstehend“. Nach zwei Stunden ohne Reservierungs-Herzschlag gilt sie auch bei
erreichbarem Mac wieder als blockiert (Fehleraudit 17.10.2026). Ein konkreter Prozentfortschritt
wird nur bei einem belegten Abschluss als 100 % angezeigt.

## Skill-Versionen in der Kopfzeile

Die Kopfzeile und der Versionsabgleich zeigen ausschließlich Content Creation (`content-creation`), Correction (`newsletter-korrektur`) und Klaviyo-Upload (`rs-klaviyo-upload`) aus dem neuesten bestätigten RS-Skills-Paket. Der unabhängige Mac-Beobachter liest dafür ausschließlich das installierte Release-Manifest und den Zeitstempel des erfolgreichen RS-Skills-Abgleichs; Pfade, Skill-Inhalte und Zugangsdaten werden nicht übertragen. Neue Meldungen kommen alle 15 Sekunden.

Der Relay behält den neuesten bekannten Stand auch über Neustarts und ältere Mac-Meldungen hinweg. Ohne aktuelle Meldung bzw. nach mehr als drei Minuten ohne erfolgreichen Skill-Abgleich heißt die Referenz „Stand ungeprüft“. „Abgleich x/y“ vergleicht Version und Inhaltsstand jedes Skills mit den installierten Paketen der sichtbaren Macs; fehlende oder veraltete Meldungen zählen niemals als aktuell. Laufende Aufträge behalten ihre fest zugeordneten Pakete.

Der Abgleich pro Mac verwendet die frische zentrale Referenz und dessen direkte Meldung des tatsächlich installierten Pakets. Ein älterer lokaler Git-Abgleich macht einen live bestätigten, identischen Skill-Inhalt nicht veraltet; ohne frische zentrale Referenz oder direkte Meldung bleibt der Stand ungeprüft.

## Bestehende Macs und Quellenfehler

Neuere Newsletter-Worker schreiben bei ihrer ClickUp-Abfrage bereits einen
Betriebsnachweis unter
`/opt/rs-hub/logs/ai-newsletter-fleet/<worker_id>.json`. Die Bridge liest diese
Dateien über den bestehenden SSH-Zugang und überträgt nur Worker-ID,
Hub-Zeitstempel, Worker-Version/-Revision und die Anzahl ausstehender
ClickUp-Statusupdates. So können bestehende Worker schon vor ihrem ersten
App-Bericht auftauchen. Claude-Auslastung und Akku sind in diesen Dateien nicht
enthalten; diese Werte kommen anschließend aus dem jeweiligen Max Monitor.

Bei angepasstem `HUB_RUNTIME_DIR` muss `MONITOR_HUB_FLEET_DIRECTORY` oder
`--fleet-directory /absoluter/hub/pfad/logs/ai-newsletter-fleet` auf den
tatsächlichen Dateispeicher zeigen. Der Standard-Reader nutzt
`config.hub.hub_dir/logs/ai-newsletter-fleet`. Nicht lesbare Hub-Dateien werden
als eingeschränkte Zusatzquelle gemeldet; sie verhindern keine vollständige
ClickUp-/Slack-Queue.

Ein Fehler bei ClickUp, Slack, dem Tag-Katalog oder der Pagination ersetzt die
Queue **niemals durch eine leere Liste**. Die Bridge übermittelt dann nur einen
Quellenfehler; das Relay behält den letzten vollständigen Snapshot und dessen
Zeitstempel. Eine erfolgreich vollständig gelesene, tatsächlich leere Queue
darf den alten Snapshot dagegen ersetzen. Relay-Fehler bestätigen keine
Übernahme und aktualisieren den lokalen Cache nicht.

## Blockierte Aufgaben abhaken

Für die Newsletter-Bridge mit konfiguriertem Fehlerkanal ist `#ai-fehler` die
gemeinsame Liste offener Fehler. Jeder noch vorhandenen Bot-Fehlermeldung entspricht
genau ein Eintrag unter „Blockiert“ in Pipeline, Queue und Aufmerksamkeitsliste,
einschließlich Worker- und Updatefehlern. Aufgabe und Lauf bleiben zugeordnet;
ein laufender Wiederholungsversuch wird zusätzlich als laufend angezeigt.
Alte ClickUp-Blockiert-Tags und abgebrochene Tests erzeugen keine zusätzlichen
offenen Fehler. Eine Kopie, die der Worker für einen zurückgezogenen Auftrag
umgeschrieben hat („🛑 Abgebrochen: ClickUp-Status zurückgezogen“), ist kein
offener Fehler und erscheint nicht unter „Blockiert“. Ein Ursachen-Beitrag, der
mehrere Aufträge nennt, ergibt je Auftrag einen Eintrag mit demselben Slack-Link.
Die ursprünglichen Quelldaten und die Ereignishistorie bleiben erhalten.

Die Bridge liest den Fehlerkanal in jedem regulären Abgleich vollständig ohne
Altersgrenze, einschließlich aller Seiten. Nach der Behebung oder dem Ende
einer aktiven Zugangssperre entfernt der Worker seine Fehlermeldung aus Slack;
der nächste erfolgreiche Abgleich entfernt sie auch aus Max Monitor. So bleiben
Löschungen und Änderungen älterer Meldungen nicht im Cache stehen. Die
Reservierungskanäle behalten ihren bisherigen Cache; unvollständige oder
fehlgeschlagene Abfragen bestätigen keine Behebung.
Die zentrale Bereinigung folgt der Regel „#ai-fehler nur bei menschlichem
Handlungsbedarf“ (Till, 17.10.2026, Fehleraudit): Eine Kopie nach dieser Regel
trägt ihren Grund (`grund`) in den Metadaten. Sie bleibt über automatische
Fortsetzungen stehen und wird erst entfernt, wenn die Aufgabe nachweislich
abgeschlossen ist; eine laufende Fortsetzung genügt nicht (`until-completed`, bei
einer erschöpften Reparaturkette mit `eskaliert` `escalated-until-completed`). Ein
Ursachen-Beitrag, der mehrere Aufträge nennt (`task_ids`), bleibt, bis alle
genannten Aufgaben abgeschlossen sind (`cause-open`). Zieht ein Worker eine Kopie
selbst zurück, verschwindet sie mit dem nächsten vollständigen Abgleich. Nur
Kopien von vor dieser Regel (ohne `grund`) entfernt die Bereinigung weiter auch,
wenn die Aufgabe nachweislich wieder läuft. „Läuft“ zählt nur mit Mac und
Versuch, also aus einer frischen Reservierung oder einem Live-Bericht des Macs; ein
bloßer ClickUp-Tag `· läuft` ohne Worker-Zuordnung genügt nicht und die Kopie bleibt
(`running-not-confirmed`). Bei pausierten, wartenden, markierten Aufgaben und
offener PM-Rückfrage bleibt die Kopie stehen (`still-open`). Welche Kopien
ohnehin stehen bleiben, entscheidet die Bereinigung aus den Metadaten des
vollständigen Kanalabrufs, ohne einen Fehlerthread zu lesen. Antwortet Slack beim
Lesen eines Fehlerthreads mit 429, endet die Bereinigung dieses Abgleichs ohne
Löschung (`skipped: 'ratelimited'`); ein einzelner nicht lesbarer Thread behält
seine Kopie (`thread-unreadable`), die übrigen werden weiter geprüft. Ein Fehler
der Bereinigung steht je Episode einmal im Log, ihr Ende ebenfalls einmal.
Solche Einträge bieten einen direkten Slack-Link und können im Monitor nicht
unabhängig abgehakt werden. Bei Quellenfehlern bleibt der letzte bestätigte Bestand
mit einer sichtbaren Quellenwarnung erhalten. Ein erfolgreich leer gelesener
Fehlerkanal ergibt null Blockierungen, auch wenn alte ClickUp-Tags stehen bleiben.

Der vollständige Queue-Vertrag enthält dafür optional `blockedErrors`, eine Liste
von Task-Datensätzen mit Status `blocked`, ID `slack-error:<channel>:<ts>` und
`errorUrl` als passendem Slack-Permalink. Nennt ein Ursachen-Beitrag mehrere
Aufträge, erhält jeder weitere Auftrag eine eigene Zeile mit der ID
`slack-error:<channel>:<ts>#<Auftragskennung>` und demselben Permalink. `[]` bestätigt einen leeren Fehlerkanal;
ein fehlendes Feld bestätigt keinen leeren Kanal. Nach dem ersten solchen Snapshot
lehnt der Relay erfolgreiche Snapshots ohne Fehlerinventar ab. Die folgenden
manuellen Erledigungen gelten nur für Quellen ohne synchronisiertes Slack-Inventar.

Queue, Queue-Log und Aufgabendetails bieten für blockierte und fehlgeschlagene
Aufgaben rechts einen Haken „Als erledigt abhaken“. Die Erledigung wird im Relay
für das gesamte Team gespeichert. Sie entfernt die Aufgabe aus „Offen“,
„Blockiert“ und „Braucht Aufmerksamkeit“; unter „Alle“ steht sie als „Erledigt“.
ClickUp und die Worker bleiben die Quelle für den tatsächlichen Arbeitsstatus.
Die manuelle Erledigung bestätigt daher keinen erfolgreichen Upload.

`POST /v1/teams/:id/fleet/tasks/complete` ist für alle authentifizierten
Team-Mitglieder verfügbar und erhält `{ "taskId": "…", "taskVersion": "…" }`.
Die Version stammt aus dem Fleet-Snapshot und schützt vor dem Abhaken einer
inzwischen veränderten Blockierung. Wiederholte Anfragen sind idempotent.

Ein unveränderter Queue-Abgleich, Quellenfehler oder Relay-Neustart erhält die
Erledigung. Ändert sich Status, Blockierungsgrund, Worker oder ClickUp-Status,
oder verschwindet die Aufgabe aus der Quelle, wird die Erledigung entfernt.
Ein neuer Lauf oder eine neue Blockierung erscheint damit wieder regulär.
Die Historie bleibt erhalten und enthält zusätzlich den Zeitpunkt des Abhakens.

## API-Vertrag

`POST /v1/teams/:id/queue` benötigt einen Admin- oder Super-Bearer. Ein erfolgreicher
Snapshot besteht aus:

```json
{
  "tasks": [
    {
      "id": "clickup:newsletter:86abc123",
      "title": "Newsletter erstellen",
      "url": "https://app.clickup.com/t/86abc123",
      "workflow": "newsletter",
      "status": "running",
      "sourceStatus": "in arbeit",
      "workerId": "newsletter-mac-1",
      "phase": "In Bearbeitung",
      "progress": 50,
      "step": "Bau der Mail",
      "previews": [
        {
          "id": "<SHA-256 des hochgeladenen JPEG>",
          "title": "Newsletter erstellen – Mail 01",
          "subject": "Betreff der Mail",
          "renderedAt": "2026-10-07T11:58:00Z",
          "render": 1,
          "width": 600,
          "height": 4800
        }
      ],
      "updatedAt": "2026-10-07T12:00:00Z",
      "tags": ["pre gen · läuft"]
    }
  ],
  "observedWorkers": [
    {
      "workerId": "newsletter-mac-1",
      "name": "newsletter-mac-1",
      "lastSeenAt": "2026-10-07T12:00:00Z",
      "workerVersion": "V1.15",
      "workerRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "pendingClickup": 0,
      "acceptingTasks": true,
      "occupiedTasks": 2,
      "maxTasks": 3,
      "places": { "korrektur": 3, "newsletter": 3, "klaviyo": 3, "translation": 3 }
    }
  ],
  "source": {
    "name": "ClickUp · AI Newsletter Creation",
    "lastSuccessAt": "2026-10-07T12:00:00Z",
    "detail": "1 Aufgaben · 1 Tags · 1 Reservierungen"
  }
}
```

`occupiedTasks`, `maxTasks` (je 0–50) und `places` sind optional; ältere Worker
senden sie nicht. Das Relay zeigt daraus je Mac `load` (`occupied`, `max`, `source`
`agent` oder `hub`, `observedAt`, `fresh`).

Ein Verweis in `previews` wird nur übernommen, wenn das Bild vorher per
`PUT /v1/teams/:id/fleet/previews/<sha256>` (Admin/Super, `image/jpeg`, höchstens
2,5 MB, ID = SHA-256 des Inhalts) gespeichert wurde. `GET` auf denselben Pfad
liefert es jedem, der die Queue lesen darf; das Dashboard lädt es mit dem
Bearer-Token und zeigt es als `blob:`-Bild.

Quellenfehler werden als `{ "source": { "name": "…", "error": "…" } }` gesendet,
optional mit dem letzten bestätigten `lastSuccessAt`. Kein `tasks`-Feld in diesem
Fall. Fleet-/Queue-Lesezugriff erfolgt über den eigenen Member-Token des
jeweiligen Macs im gemeinsamen Team; Queue- und Member-Verwaltung bleiben an
Rollen gebunden.

Referenz für die Quellabfragen:
[ClickUp Get Filtered Team Tasks](https://developer.clickup.com/reference/getfilteredteamtasks),
[Slack conversations.history](https://docs.slack.dev/reference/methods/conversations.history/).

## Worker-Fehler trotz erreichbarem Mac

Ein frischer Geräte- oder Worker-Heartbeat bestätigt die Erreichbarkeit. Er
bestätigt nicht, dass Claude angemeldet ist oder der Worker Aufgaben ausführen kann.
Die Bridge liest deshalb auch die noch vorhandenen Worker-Warnungen aus Slack
(`ai_newsletter_fehler`, Arten `system` und `update`). Sie ordnet sie über die
exakte Worker-ID zu. Der konfigurierte Fehlerkanal wird zusätzlich gelesen;
ohne separaten Fehlerkanal kommen die Warnungen aus dem Statuskanal.

OAuth-/Anmeldefehler, andere gemeldete System- und Updatefehler erscheinen mit
Diagnose in der Mac-Übersicht, den Details und „Braucht Aufmerksamkeit“. Ein
Worker ohne frischen Heartbeat fällt auch bei weiterhin erreichbarer Mac-App
auf. Ausstehende ClickUp-Statusupdates und ein unbekannter Worker-Betriebsstatus
werden ebenfalls angezeigt. Die Warnliste zählt jeden betroffenen Mac einmal.

Die API übernimmt dafür optional `workerIssues` im Queue-Snapshot:
`{ id, workerId, stage, severity: "error" | "warning", message, reportedAt }`.
Fehlt das Feld, bleiben die bisherigen Warnungen bestehen. Eine vollständige
leere Liste entfernt sie. Das gilt auch bei einem ClickUp-Quellenfehler: Aufgaben
bleiben erhalten, unabhängig erfolgreich gelesene Warnungen können aktualisiert
werden. Ein unvollständiger Slack-Abruf darf keine Warnungen löschen.

Eine Warnung bleibt sichtbar, bis der Worker seine Slack-Meldung entfernt und
die Bridge den Kanal erneut vollständig gelesen hat. Ältere Worker können
behobene Warnungen länger behalten; der gemeldete Zeitpunkt steht in den Details.
Die Diagnose wird begrenzt und Zugangsdaten werden vor der Übertragung entfernt.
Eine Warnung erzeugt niemals einen künstlichen Geräte-Heartbeat.

### Erreichbarkeit und App-Daten

Bei einem Mac mit exakt zugeordneter Worker-ID zählt das neueste plausible Lebenszeichen der Mac-App oder des Newsletter-Workers für `status`, `lastSeenAt` und `heartbeatAgeSeconds`. Auch die Mac-Erreichbarkeitsereignisse folgen diesem gemeinsamen Zustand. `nativeLastSeenAt`, `nativeStatus`, `nativeHeartbeatAgeSeconds` sowie `workerLastSeenAt`, `workerStatus`, `workerHeartbeatAgeSeconds` erhalten die getrennten Quellen. Worker-Zeitstempel mehr als fünf Minuten in der Zukunft werden nicht als Lebenszeichen verwendet. Queue-Synchronisation und Worker-Fehler erneuern keine Lebenszeichen.

Die native Telemetrie und ihre Messzeitpunkte bleiben unverändert. Alte Akkuwerte und Always-On-Daten gelten nicht als aktuell; Kontingente behalten ihre separate Frischebewertung. Inhaber-, Admin- und Gastzugänge senden absichtlich keine eigenen Mac-Meldungen. Ihre laufenden, zugeordneten Newsletter-Worker bestätigen weiterhin die Erreichbarkeit.
