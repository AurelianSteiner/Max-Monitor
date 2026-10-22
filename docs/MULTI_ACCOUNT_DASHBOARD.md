# Multi-Account-Dashboard (Übersicht)

Kurzdoku zur Mehrkonten-Übersicht: was sie tut, wie sie aufgebaut ist und worauf man
beim Weiterbauen achten sollte.

## Warum

Bisher zeigte die App immer nur das **aktive** Konto. Wer mehrere Claude-Accounts hat,
musste oben im Menü umschalten, um zu sehen, wie voll das jeweils andere Kontingent ist.
Die Übersicht zeigt stattdessen alle Konten gleichzeitig nebeneinander.

## Bedienung

| Weg | Ergebnis |
|---|---|
| Klick auf das Menüleisten-Symbol | Übersicht (sobald ein Provider mehr als ein Konto hat) |
| „…“-Menü in der Übersicht → *Einzelansicht anzeigen* | zurück zum klassischen Detailfenster |
| „…“-Menü im Detailfenster → *Übersicht anzeigen* | umschalten auf die Übersicht |
| Rechtsklick auf das Menüleisten-Symbol → *Übersicht in Fenster öffnen* (⌘D) | eigenständiges Fenster, bleibt beim Fokuswechsel offen |
| Klick auf eine Karte | dieses Konto wird das aktive (Menüleisten-Symbol folgt) |
| Klick auf die Limit-Zeilen | umschalten zwischen Reset-Zeitpunkt und Restzeit |
| Rechtsklick auf eine Karte | nur dieses Konto aktualisieren / als aktiv setzen |

Einstellungen → Allgemein → **Übersicht**: An/Aus, Sortierung (Reihenfolge vs.
freieste zuerst) und Spaltenzahl (1–3).

Badges auf den Karten:

- **Aktiv** — das Konto, dem das Menüleisten-Symbol gerade folgt (je Provider eins)
- **Fast aufgebraucht** — irgendein Limit dieses Kontos liegt bei ≥ 90 %
- **Am freisten** — von allen Konten mit Daten das mit dem niedrigsten Spitzenwert

## Architektur

```
Views/Dashboard/
  DashboardView.swift          Container + DashboardMetrics (Layout & Höhenberechnung)
  AccountUsageCard.swift       eine Karte pro Konto
  DashboardComponents.swift    kompakter Ring, Badges, Farbmapping
  DashboardWindowManager.swift eigenständiges Fenster
Helpers/DashboardRefreshManager.swift   Datenschicht
Models/AccountUsageSnapshot.swift       Zustand pro Konto
```

### Abgrenzung zu `DataRefreshManager`

`DataRefreshManager` bleibt zuständig für das Menüleisten-Symbol des aktiven
Kontos, die Smart-Refresh-Steuerung und die Codex-Token-Kette — und sieht
weiterhin **nur das aktive Konto**. `DashboardRefreshManager` ist eine separate, parallele Datenschicht, die
für **jedes** Konto eine eigene, an dieses Konto gebundene Service-Instanz hält. Ist die
Übersicht nicht sichtbar, sendet sie keine Requests (`activate()` / `deactivate()` per
Referenzzählung aus `onAppear` / `onDisappear`).

### Kontogebundene Services

`ClaudeAPIService(account:)` und `CodexAPIService(account:)` nehmen ihre Zugangsdaten aus
dem übergebenen `Account` statt aus `UserSettings.currentAccount`. Zwei Details sind dabei
wichtig und dürfen nicht verloren gehen:

1. **Eigener Cookie-Speicher.** Gebundene Instanzen setzen
   `httpCookieStorage = nil` / `httpShouldSetCookies = false`. `sessionKey` (Claude) und
   `__Secure-next-auth.session-token` (Codex) sind gleichnamige Cookies — über den
   geteilten `HTTPCookieStorage.shared` würden sich parallele Requests verschiedener
   Konten gegenseitig überschreiben. Maßgeblich ist ausschließlich der explizit gesetzte
   `Cookie`-Header aus den Header-Buildern.
2. **Token-Rotation kontoscharf zurückschreiben.** OAuth-`refresh_token`s rotieren bei
   jeder Erneuerung. Gebundene Instanzen schreiben über
   `silentlyUpdateClaudeSessionToken(accountId:token:)` bzw.
   `silentlyUpdateCodexSessionToken(accountId:token:)` zurück — nie über die
   `…Current…`-Variante, sonst landet der neue Token beim falschen Konto.
   Die Codex-Cookie-Rotationserkennung (liest `HTTPCookieStorage.shared`) läuft aus dem
   gleichen Grund nur in der ungebundenen Standardinstanz.

### Layout-Höhen

Der Popover übernimmt seine Größe über
`NSHostingController.sizingOptions = .preferredContentSize`. Ein `ScrollView` hat keine
endliche Idealgröße, deshalb rechnet `DashboardMetrics` die Kartenhöhen aus der Anzahl
der Limit-Zeilen aus und setzt eine feste Höhe (gedeckelt auf `maxGridHeight`, darüber
wird gescrollt). **Wichtig:** Karte und Höhenrechnung müssen dieselbe Regel benutzen,
welche Zeilen angezeigt werden — deshalb liegen `activeTypes(for:)` und
`overflowWeeklyModels(for:)` in `DashboardMetrics` und nicht in der Karte.

### Refresh-Verhalten

- automatisch: `max(60 s, effectiveRefreshInterval)` — eine Runde bedeutet *n* Requests,
  deshalb nicht die aggressiveren Intervalle des Einzelkonto-Pfads
- beim Öffnen: nur wenn die Daten älter als 30 s sind
- manuell (Kopfzeile): 10 s Entprellung, wie im Detailfenster
- Requests werden um je 250 ms versetzt gestartet

## Bauen ohne Xcode

`./scripts/build_without_xcode.sh` baut mit den Command Line Tools ein lauffähiges
Universal-`Usage4Claude.app` (Sparkle wird bei Bedarf automatisch geladen). Unterschiede
zum offiziellen `scripts/build.sh`:

- kein `actool` ohne Xcode → die vier benötigten Icons liegen als lose Dateien im Bundle
  statt in einer `Assets.car`; `NSImage(named:)` findet sie dort genauso
- Ad-hoc-Signatur statt Developer ID, nicht notarisiert
- `SUEnableAutomaticChecks` wird auf `false` gesetzt, damit ein Sparkle-Auto-Update
  diesen Build nicht durch das offizielle Release ersetzt
- `CFBundleShortVersionString` bekommt das Suffix `+dashboard`, damit man den Build in
  „Über Usage4Claude“ erkennt
- die `$(PRODUCT_BUNDLE_IDENTIFIER)`-Platzhalter in
  `Config/Usage4Claude.entitlements` werden vor dem Signieren aufgelöst — `codesign`
  kennt keine Build-Variablen, sonst landeten die Sparkle-mach-lookup-Ausnahmen
  wörtlich im Bundle
- ohne `SDKROOT` prüft das Skript, ob die Standard-SDK SwiftUI ohne das Makro-Plugin
  `SwiftUIMacros` übersetzt (das nur Xcode mitliefert; ab `MacOSX27.sdk` ist `@State`
  ein Makro). Wenn nicht, baut es mit der neuesten installierten SDK, die das kann, und
  nennt sie im Log; `./scripts/build_without_xcode.sh --print-sdk` zeigt die Wahl
  ohne zu bauen. Eine gesetzte `SDKROOT` gilt unverändert

Name und Bundle-ID sind überschreibbar, um parallel zu einer bestehenden Installation
zu laufen (getrennte Einstellungen und Keychain):

```bash
U4C_PRODUCT_NAME="Usage4Claude 2.0" U4C_BUNDLE_ID=xyz.fi5h.Usage4Claude2 \
  ./scripts/build_without_xcode.sh
```

Hinweis: Ein ad-hoc signierter Build hat eine andere Code-Identität als ein offiziell
signiertes Release. Der Keychain-Eintrag mit den Konten ist an die Identität gebunden —
nach dem Wechsel müssen die Konten unter Umständen einmalig neu angemeldet werden.
