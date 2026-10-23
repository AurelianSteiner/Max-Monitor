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

1. **Ein Satz statt Zahlensalat** oben („2 Aufgaben laufen, 3 brauchen dich“)
   plus fünf große Kacheln: Läuft · Wartet · Blockiert · Heute fertig · Macs bereit.
2. **„Braucht dich“**: eine Liste für Mac- und Aufgabenprobleme, Grund in
   Klartext, je ein Knopf zum Beheben („Claude neu anmelden“, „Liste
   zuordnen“ …) – mit denselben Beschriftungen wie auf Aufgaben und Macs.
3. **Fluss je Aufgabenart** statt Balkendiagrammen: ein gestapelter Balken
   (wartet/läuft/blockiert/fertig) + typische Dauer pro Art.
4. **Art-Farben = Brief-Farben der Werkstatt**: Newsletter blau, Upload orange,
   Übersetzung türkis, QA lila.
5. **Aufgaben als Board** (Wartet · Läuft · Blockiert · Fertig heute) mit
   Detail-Panel inkl. Schritten; „Verlauf heute“ ersetzt das Log.
6. **Macs als kompakte Zeilen**: Zustand in Worten, aktuelle Aufgabe,
   beschriftetes „Claude-Kontingent“ (5-h-Fenster / Woche); Technik
   (CPU, RAM, Platte, Version) nur im Detail-Panel mit Bereitschafts-Check.
7. **Statistik beantwortet Fragen**: Wie viel wird fertig? Wie lange dauert es
   (typisch + langsamste 10 %)? Warum hängt es? Wann wird das Kontingent knapp
   (Raster Mac × Tag)?

## Stil

Inter, heller Grund `#F5F5F3`, weiße Karten mit feinem Rand, Akzent Blau
`#2563EB`; Status: läuft blau, wartet bernstein, blockiert rot, fertig grün;
Texte mit ≥ 4,5:1 Kontrast, echte Buttons/Links (tastaturbedienbar).

## Offen / nächste Schritte

- Owner-Feedback zum Entwurf einholen.
- Danach entscheiden, welche Teile ins echte Dashboard kommen; Blockier-Gründe
  und Schritte müssen dafür vom Worker gemeldet werden (heute nur teilweise).
