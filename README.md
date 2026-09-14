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

Die Zugangsdaten bleiben im Schlüsselbund des Macs. Keine Telemetrie, keine Konten bei Dritten — die App spricht ausschließlich mit den Schnittstellen, bei denen du dich angemeldet hast.

## Team

Für den Privatgebrauch ist die App frei — herunterladen und loslegen.

Wer die Auslastung eines ganzen Teams sehen will (eine Karte pro Person, wer hat noch Luft, wer ist durch), braucht Zugang zum Team-Relay: Server-Adresse, Team-ID und ein persönliches Token. Teams gibt es auf Anfrage — kurze Mail genügt. Der Team-Inhaber legt Mitglieder mit Namen an und verschickt deren Tokens; jedes Mitglied meldet nur Prozentwerte und Reset-Zeitpunkte, niemals Zugangsdaten. Mitglieder sehen nur sich selbst, Admins das ganze Team.

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
