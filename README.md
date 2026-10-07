# Max Monitor

Alle Claude-Max- und Codex-Konten auf einen Blick in der Menüleiste — statt eines nach dem anderen.

## Download

**[Neueste Version herunterladen](https://github.com/AurelianSteiner/Max-Monitor/releases/latest)** — DMG öffnen, App nach „Programme" ziehen.

Beim ersten Start Rechtsklick auf die App → **Öffnen**. Die App ist nicht bei Apple notarisiert, deshalb fragt macOS einmal nach. Danach startet sie normal.

Ab dann meldet sie sich selbst, wenn eine neue Version erscheint.

## Worum es geht

Wer mehrere Claude-Max- oder Codex-Zugänge hat, kennt das Problem: du willst wissen, mit welchem Konto du weiterarbeiten kannst, und musst dafür zwischen ihnen durchklicken. Vier Konten heißt vier Klicks, und am Ende hast du die erste Zahl schon wieder vergessen.

Diese App zeigt alle Konten gleichzeitig, eine Karte pro Zugang:

**Das Wochenlimit als Leitzahl.** Groß, farbig, sofort lesbar. Daran hängt die Planung — nicht am Sitzungsfenster, das sich alle fünf Stunden von selbst erledigt.

**Das Sitzungsfenster als Wasserstand.** Ein Kreis, der sich füllt. Die Prozentzahl darin wird an der Wasserlinie zweifarbig, bleibt also in jedem Füllstand lesbar.

**Farbe sagt, wie eng es wird.** Claude: Blau, wenn Luft ist, dann Gelb, Orange, Rot, je näher das Limit rückt. Codex bleibt in Blau und wird mit jeder Stufe dunkler — Himmelblau, Azur, Königsblau, Indigo. Ein Blick über alle Karten genügt, und die Anbieter sind sofort auseinanderzuhalten.

**Countdown, wenn es knapp wird.** Freischaltung in unter drei Tagen zeigt die Restzeit, alles darüber das Datum. Der genaue Tag steht im Tooltip.

**Weitere Limits automatisch.** Opus, Fable, Extra Usage — was das Konto meldet, erscheint auf der Karte, Modell-Wochenlimits als Prozentbalken.

**Gekündigt bis.** Für ein gekündigtes Abo lässt sich in den Einstellungen der letzte Tag eintragen; die Karte zeigt ihn als kleine Plakette („endet 9. Okt.“) samt Restzeit im Tooltip. Von Hand, weil keine Schnittstelle dieses Datum liefert.

**Wasserstände in der Menüleiste.** Ein Punkt je Konto: Die Füllung folgt dem Wochenlimit, ein roter Ring markiert ein aufgebrauchtes Sitzungsfenster. Schmal genug für die Notch. ChatGPT-/Codex-Kontingente stehen in derselben Übersicht, in ihrem eigenen Blau.

**Eine Parade je Konto.** Solange „Claude Always On“ den Mac wach hält, laufen oben kleine Pixel-Wesen durch: ein Claudie je Claude-Konto, ein blaues Codex-Pet je Codex-Konto, nie mehr gleichzeitig als Konten eingetragen sind.

Die Zugangsdaten bleiben im Schlüsselbund des Macs. Ohne Team-Verbindung spricht
die App ausschließlich mit den Schnittstellen, bei denen du dich angemeldet hast.
Mit Team-Verbindung werden die unten beschriebenen Nutzungs- und Geräteberichte
an deinen gewählten Team-Server übertragen; Claude-Zugangsdaten bleiben lokal.

## Team

Für den Privatgebrauch ist die App frei — herunterladen und loslegen.

Wer die Auslastung eines ganzen Teams sehen will (eine Karte pro Person, wer hat noch Luft, wer ist durch), braucht Zugang zum Team-Relay: Server-Adresse, Team-ID und ein persönliches Token. Teams gibt es auf Anfrage — kurze Mail genügt. Der Team-Inhaber legt Mitglieder mit Namen an und verschickt deren Tokens; jedes Mitglied meldet nur Prozentwerte und Reset-Zeitpunkte, niemals Zugangsdaten. Mitglieder sehen nur sich selbst, Admins das ganze Team.

## Mac-Worker und AI Newsletter Creation

**„Queue & Macs“** neben Always On öffnet eine große, frei skalierbare Übersicht:
alle Worker, Akku und Stromversorgung, Claude-Kontingente pro Konto, letzte Meldung
und die gemeinsame Aufgaben-Queue mit Status, Worker-Zuordnung und Queue-Log.
Pre-Gen, Uploads und weitere Workflows lassen sich filtern und durchsuchen.

Jede verbundene App meldet ihren Mac alle zehn Minuten, beim Start und nach dem
Aufwachen. Nach 15 Minuten ohne Meldung ist ein Gerät „still“, nach 30 Minuten
„offline“. Fehler oder alte Claude-Messungen bleiben separat sichtbar. Der
Newsletter-Abgleich liest ClickUp, Slack-Reservierungen und bestehende
Hub-Worker-Berichte; bei Quellenfehlern bleibt die letzte vollständige Queue stehen.

Alle Installationen nutzen **denselben zentralen Team-Server und dieselbe Team-ID**,
jeder Mac mit eigenem Mitglieds-Token und einer eindeutigen Worker-ID. Alle
Team-Mitglieder sehen die gemeinsame Worker- und Queue-Übersicht; die bisherige
persönliche Team-Auslastungsansicht behält ihre Rollen. Claude-Zugangsdaten bleiben
auf dem jeweiligen Mac. Das Repository verteilt den Code, der Server hält den
gemeinsamen Zustand unabhängig von einem Arbeits-Mac.

Die [Einrichtungsanleitung](docs/fleet-monitoring.md) erklärt den zentralen Server,
die Zuordnung der Macs, die Newsletter-Brücke und deren Hintergrunddienst.

Das neue-Mac-Setup von **AI Newsletter Creation** und der RS-Skills-Befehl
`install.sh --worker-mac` installieren und verbinden Max Monitor automatisch. Server-Adresse,
Team-ID und ein eigener Member-Token kommen über den vorhandenen SSH-Zugang vom
RS Hub. Auf dem Mac bleiben nur dessen eigene Zugangsdaten. Details stehen unter
[automatischer Worker-Anmeldung](docs/worker-enrollment.md) und
[zentraler Hub-Einrichtung](docs/hub-installation.md).

## Selbst bauen

Xcode ist nicht nötig, die Command Line Tools reichen:

```bash
./scripts/build_without_xcode.sh
```

Eigene Version veröffentlichen:

```bash
./scripts/release.sh 1.1 "Was neu ist"
```

Das baut, packt die DMG, signiert sie, schreibt `appcast.xml` fort und legt das GitHub-Release an.

## Herkunft

Fork von [Usage4Claude](https://github.com/f-is-h/Usage4Claude) von f-is-h, MIT-Lizenz. Die Mehrkonten-Übersicht, die Wasserstand-Anzeige und der Build ohne Xcode sind in diesem Fork entstanden.

Lizenz: MIT — siehe [LICENSE](LICENSE).
