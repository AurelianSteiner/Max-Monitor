# New Design Prototyp – Team-Dashboard Redesign

UI-Mockup für ein moderneres, verständlicheres Team-Dashboard von Max Monitor
(Ansichten Übersicht · Aufgaben · Macs · Statistik). **Nur Design, kein
Produktionscode** – das heutige Dashboard (`team-server/public/dashboard.*`) ist
unverändert.

- **Live ansehen (klickbarer Prototyp, Design-Canvas):**
  https://claude.ai/artifact/Tdphp8qbGUyNDdPX7aLnyK (privat – im Artifact über
  „Teilen“ freigeben, wenn andere es öffnen sollen)
- Entstanden: 21.10.2026 auf Basis des Dashboards im Testdaten-Modus
  (`dev-workshop.html?fixtures=1`). Alle Zahlen sind **Beispieldaten**; sie
  sind seitenübergreifend stimmig und beziehen sich auf „jetzt“ = Mittwoch,
  12:48 Uhr.

## Dateien

| Datei | Inhalt |
|---|---|
| `artboards/canvas.json` | Anordnung der vier Bildschirme auf dem Canvas |
| `artboards/Main.dc.html` | 1 · Übersicht |
| `artboards/Aufgaben.dc.html` | 2 · Aufgaben (Queue + Verlauf zusammengelegt) |
| `artboards/Macs.dc.html` | 3 · Macs |
| `artboards/Statistik.dc.html` | 4 · Statistik |
| `werkstatt.jpg` | Werkstatt-Bild, das die Übersicht zeigt |

Die `.dc.html`-Dateien sind im Format des Claude-Design-Canvas geschrieben
(`<x-dc>`-Markup + `class Component extends DCLogic`); sie laufen im Artifact,
nicht direkt im Browser. Das Werkstatt-Bild ist dort als Asset
`/_blob/fe1e8fb9f1107f6f767018454b2108a5` eingebunden – lokal entspricht das
`werkstatt.jpg`. Zum Weiterbearbeiten in einer neuen Session: Artifact-Link
öffnen bzw. mit dem Artifact-Tool lesen, oder diese Dateien als Vorlage nehmen.

## Was am heutigen Dashboard stört (Ausgangslage)

- Übersicht/Liste: „Pipeline“ als Balkendiagramme mit fast nur 0/1-Werten –
  viel Fläche, wenig Aussage; Kategorie „Markiert“ unklar.
- Macs: Karten überladen (Akku, Limits, RAM, CPU, macOS, App, Platte …),
  Warnungen als verstreuter oranger Text; in der Liste unklar, was „5 h“ und
  „Woche“ bedeuten.
- „Braucht Aufmerksamkeit“ mischt Mac- und Aufgabenprobleme ohne direkte Aktion.
- Log: sehr kleinteilig, viele Wiederholungen („Wartet“, „Reserviert“).

## Leitideen des Entwurfs

1. **Ein Satz statt Zahlensalat** oben („2 Aufgaben laufen – 3 Aufgaben und
   3 Macs brauchen dich“) plus fünf große Kacheln: Läuft · Wartet · Blockiert ·
   Heute fertig · Macs einsatzfähig (arbeiten, starten gleich oder frei – im
   Gegensatz zu „mit Problem“). Ein Mac mit reservierter Aufgabe heißt
   „Startet gleich“ wie im echten Dashboard, nicht „Frei“.
2. **„Braucht dich“**: eine Liste für Mac- und Aufgabenprobleme, Grund in
   Klartext, je ein Knopf zum Beheben („Claude neu anmelden“, „Liste
   zuordnen“ …) – mit denselben Beschriftungen wie auf Aufgaben und Macs.
3. **Fluss je Aufgabenart** statt Balkendiagrammen: ein gestapelter Balken
   (wartet/läuft/blockiert/fertig) + typische Dauer pro Art.
4. **Aufgabenart = Symbol aus dem Aufgaben-Schrank der Werkstatt** (Dokument
   blau = Newsletter, Wolke orange = Upload, Übersetzen türkis, Häkchen lila =
   QA) statt farbiger Quadrate – so konkurrieren Art-Farben nicht mit den
   Zustandsfarben. Reine Art-Farbflächen nur in Diagrammen, die ausschließlich
   nach Art aufschlüsseln (Statistik).
5. **Aufgaben als Board** (Wartet · Läuft · Blockiert · Fertig heute) mit
   Detail-Panel inkl. Schritten; „Verlauf heute“ ersetzt das Log.
6. **Macs als kompakte Zeilen**: Anzeigename mit Tuck-Farbe („Rot“, „Blau“,
   „Gelb“, „Schwarz“, „MacBook von Till“ – aus
   `team-server/worker-identities.json`, wie im echten Dashboard), Zustand in
   Worten, aktuelle Aufgabe, beschriftetes „Claude-Kontingent“ (5-h-Fenster /
   Woche); Rechnername und Technik (CPU, RAM, Platte, Version) nur auf der
   Macs-Seite bzw. im Detail-Panel mit Bereitschafts-Check.
7. **Statistik beantwortet Fragen**: Wie viel wird fertig? Wie lange dauert es
   (typisch = Median, dazu „jede 10. ab …“)? Warum hängt es? Wann wird das
   Kontingent knapp (Raster Mac × Tag)? Dauern heißen überall „typisch“, nie Ø.
8. **Übersicht ohne Leerfläche**: Werkstatt und Fluss links, „Braucht dich“
   rechts, Macs als Kachelreihe darunter – bei 1440 px passt alles auf einen
   Bildschirm, bei 1180 px ist der Fluss ohne Scrollen sichtbar.

## Stil

Inter, heller Grund `#F5F5F3`, weiße Karten mit feinem Rand, Akzent Blau
`#2563EB`; Texte mit ≥ 4,5:1 Kontrast, echte Buttons/Links (tastaturbedienbar).

Drei Farbsysteme, klar getrennt:

- **Zustand = Farbe** (immer mit Wort daneben): wartet/offline grau, läuft
  blau, blockiert/Fehler rot, fertig/ok grün; Bernstein nur für Warnungen
  (Kontingent ab 60 %, Meldung fehlt, hohe CPU-Last), Rot fürs Kontingent ab
  90 %.
- **Aufgabenart = Symbol** in Schrank-Farbe (siehe 4).
- **Mac = Name + kleines Tuck-Farbfeld**, nur wo der Mac selbst das Thema ist
  (Mac-Zeilen, Mac-Einträge in „Braucht dich“, Heatmap); persönliche Macs
  ohne Tuck-Farbe bekommen ein leeres Feld.

## Offen / nächste Schritte

- Owner-Feedback zum Entwurf einholen.
- Danach entscheiden, welche Teile ins echte Dashboard kommen; Blockier-Gründe
  und Schritte müssen dafür vom Worker gemeldet werden (heute nur teilweise).
