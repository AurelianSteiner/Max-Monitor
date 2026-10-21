# Max Monitor Technische Auditkorrekturen

Die 19 technischen Punkte aus dem Audit sind im Branch `codex/audit-technical-fixes` korrigiert oder als bereits korrigierter Hauptstand durch Regressionstests abgesichert. Die beiden zusätzlichen technischen Vertragsbeobachtungen zu Schlüssellängen und abgelaufenen Account-Aufträgen sind ebenfalls behoben. Die fachliche Frage F11 bleibt separat in [Offene Entscheidungen](open-decisions.md).

Die Änderungen basieren auf Hauptstand `aa3f426a60b7ea2a4a76218bad5231df166f5daa`. Der ältere Audit-Checkout und seine fremden lokalen Änderungen wurden nicht verändert. Die erste Abnahme erfolgte lokal und mit künstlichen Daten in isolierten Ablagen. Der anschließende Produktionsrollout ist in [Live-Ausrollung und Abnahme](rollout.md) dokumentiert.

## Korrekturen und Nachweise

| Punkt | Ergebnis | Prüfung |
| --- | --- | --- |
| F01 P1 Kontowechsel bei Token-Erneuerung | Konto-ID und Cache vor dem asynchronen Schritt gebunden; Rotation vergleicht den ursprünglichen Tokenstand. Überholte Ergebnisse aktualisieren die Menüleisten-Daten nicht. | Originale Swift-Methoden mit Wechsel A → B; verspätete Rotation nach neuer Anmeldung verworfen; B bleibt unverändert. |
| F02 P1 Fehlendes Installationsmodul | Installer und Runtime-Veröffentlichung verwenden ein gemeinsames Manifest. Es enthält auch vorher fehlende indirekte Module, Setup-Abhängigkeiten und Planungsassets. | Tatsächlich erzeugtes leeres Staging-Paket: Bridge und Installer mit `--help`, Setup-Import und Relay-Import erfolgreich; verlinkte Webassets vorhanden. |
| F05 P2 Ungeordnete Kontopersistenz | Gemeinsame serielle Persistenzqueue für beide Kontolisten; Schreibaufträge behalten Speicher und Snapshot bis zum Abschluss. Fehlschläge sind als Speicherstatus beobachtbar. | Ersten Schreibauftrag angehalten: neuer Snapshot bleibt dahinter und wird zuletzt gespeichert. Fehlgeschlagene Speicherung für beide Kontolisten sichtbar. |
| F04 P2 Unbekannte Aktivität | Unbekannte Laufbeobachtungen entfernen keine bestehende Worker-Zuordnung. | Lauf bleibt über Speicherung und Neustart zugeordnet; bestätigter Leerlauf kann die Zuordnung weiterhin entfernen. |
| F15 P2 Alter Fertig-Tag | Ein Fertig-Tag ohne passenden Abschlussbeleg beendet keinen neuen Auftrag mit eigener Statusepoche. | Bridge → Relay → gespeicherter Zustand → Neustart bleibt bei laufendem neuen Versuch; echter Abschluss und nachgelagerte Freigabe bleiben abgeschlossen. |
| F06 P2 Optionaler Deckelschutz | Watchdog folgt gemessenen Änderungen von `SleepDisabled`; ein fehlender optionaler Deckelschutz hebt IOKit-Assertions nicht auf. | Wiederholtes `false` nach erfolgreichem Assertionsaufbau erhält den Wachschutz. Tatsächlicher Wechsel an → aus und externes Einschalten bleiben wirksam. |
| F08 P2 Ungültiger Callback | Segmentzugriff vor Verwendung geprüft. | `#` und leere Eingabe ohne Absturz; gültiges `code#state` und URL mit kodiertem Code bleiben lesbar. |
| F07 P2 Wiederholte ungültige Anmeldung | Endgültige Grant-Ablehnung erreicht den gemeinsamen Cache; außen bleibt die Meldung zur abgelaufenen Anmeldung erhalten. | Zwei Abrufe eines toten Tokens verursachen einen Endpunktaufruf; temporäre Netzwerkfehler bleiben wiederholbar. |
| F09 P2 Slack-Seiten | Statusreader folgt Cursorn mit Seitenlimit und Schutz vor wiederholten Cursorn. Unvollständige Ergebnisse bleiben unbestätigt. | Neuer Status auf zweiter Seite gewählt; wiederholter Cursor begrenzt; vorhandene Budget-, Cache- und 429-Prüfungen bestehen. |
| F10 P2 Runtime-Voraussetzungen | Mindestversion und Dokumentation angeglichen. Preflight führt vor Dienständerungen eine SQLite-Abfrage und einen echten Sharp-JPEG-Render aus. | Node 22.22.2 mit SQLite und nativer Sharp-Bibliothek erfolgreich; fehlendes Sharp und fehlgeschlagene Probe werden abgewiesen. |
| F17 P2 Verschachtelte Belege | Top-Level- und Vertragsbelege anhand ihrer eigenen Prüfzeit normalisiert. | Verschachtelter Alleinbeleg überlebt Neustart; neuerer Fehler verdrängt älteren Erfolg in beiden Darstellungen. |
| F16 P2 Abgelaufene Planungsfenster | Aktuelle Kapazität benötigt ein bekanntes, noch nicht abgelaufenes Resetfenster. | Abgelaufene, fehlende und ungültige Resets bleiben unbekannt. Browser sperrt die Mengen und stellt sie nach frischen Fenstern wieder her. Hypothetischer Vollmodus bleibt verfügbar. |
| F03 P2 Identitätskollision | Native Heartbeats berücksichtigen Enrollment-Reservierungen; bestehende Links zu nativen Macs können nicht durch eine andere Geräte-ID überlagert werden. | Fremder manueller Zugang wird vor der ersten legitimen Meldung abgewiesen. Sein Löschen beschädigt die legitime Anmeldung und Neuregistrierung nicht. |
| F18 P2 Unvollständiges Löschen | Zugehörige direkte Berichte und Account-Aufträge werden vor Abschluss der Löschung bereinigt. | Zielbericht und Auftrag nach Neustart entfernt; anderer Mac und gemeinsame Queue erhalten. |
| F19 P2 Verspäteter Rechteentzug | Schreibpfade prüfen die aktuelle Rolle bzw. Mitgliedschaft unmittelbar vor der Mutation erneut. Aufwandsänderungen speichern die tatsächliche Mitglieds-ID. | Gepufferte Aufwand-, Klärungs- und Account-Anfragen nach Herabstufung abgewiesen; gepuffertes Abhaken nach Löschung abgewiesen. |
| F14 P2 SSH-Annahmefeld | Im verwendeten Hauptstand bereits vorhanden; beide Leser sind nun gemeinsam abgesichert. | SSH- und lokaler Reader liefern dieselbe Telemetrie einschließlich `acceptingTasks=false`. |
| F20 P2 Setup-Vertrag | Der aktuelle Hauptstand enthält die zentrale Namens-/Farbzuordnung und Login-Behandlung. Das erzeugte Paket enthält diesen Stand und seine Importabhängigkeiten. | Vollständige Setup-Suite einschließlich der sieben früher fehlgeschlagenen Vertragsfälle bestanden; importierbares Staging-Paket. |
| F12 P3 Vorschauen nach Neustart | Persistierte Vorschauen bleiben an denselben Versuch gebunden. Eine stabile Mail-ID ermöglicht den Fallback für einzelne Mails. | Kalter Reader mit leerem Ergebnis erhält gültige alte Vorschau; anderer Versuch und abgelaufene Bilder werden ausgeschlossen. Teilerfolg ersetzt eine Mail und erhält die andere. |
| F13 P3 Ruhephasenzähler | Nutzungsänderung setzt den Zähler auch bei bereits aktivem Modus zurück. | Messfolge 10, 10, 20, 20 bleibt aktiv; erst die vorgesehenen weiteren unveränderten Messungen schalten herunter. |

Zusätzlich akzeptiert der Account-Empfang nur die unterstützten RSA-Größen 3072 und 4096 Bit; die erwartete Länge des verpackten Schlüssels folgt exakt dem Empfängerschlüssel. Abgelaufene versiegelte Inhalte werden auch bei gedrehtem Empfängerschlüssel entfernt. Der Relay bereinigt sie beim Start und anschließend regelmäßig ohne neue Worker-Meldung.

## Gesamtergebnis der Verifikation

| Prüfung | Ergebnis | Beleg |
| --- | --- | --- |
| Vollständige Node-Suite unter Node 22.22.2 | 523 bestanden, keine Fehler oder Auslassungen | [Log](verification/node22.txt) |
| SwiftPM | 195 bestanden, keine Fehler | [Log](verification/swift.txt) |
| Python | 130 bestanden; 6 Linux-Mount-Prüfungen auf macOS ausgelassen | [Log](verification/python.txt) |
| Native Regressionen | 5 Szenariogruppen mit Produktionsmethoden bestanden | [Log](verification/native-regressions.txt) |
| Verschlüsselter Kontospeicher | 156 Prüfungen bestanden, 0 echte Keychain-Aufrufe | [Log](verification/credential-storage.txt) |
| Vollständiger App-Build | Debug und Release erfolgreich | [Debug](verification/debug-build.txt), [Release](verification/release-build.txt) |
| Lokalisierung | Je 335 Schlüssel in beiden Sprachen konsistent | [Log](verification/localization.txt) |
| Echte Browserabläufe gegen isolierten Relay | 1440×900, 1024×768 und 390×844 bestanden; keine Seitenfehler und kein horizontaler Überlauf | [Ergebnis](verification/browser-review.json) |
| Runtime-Preflight | Echte SQLite-Abfrage und nativer Sharp-JPEG-Render unter Node 22.22.2 erfolgreich; fehlendes Sharp abgewiesen | [Quellgebundene Verifikation](verification.json) |

Die Browserprüfung umfasst aktuelle und hypothetische Kapazität, Tages-/Wochenansicht, Mengeneingaben, Tastaturbedienung, Verbindungsausfall und Wiederherstellung sowie abgelaufene Resetfenster. Die Screenshots wurden für alle drei Größen visuell geprüft: Meldung und deaktivierte Mengen sind lesbar, die Navigation bleibt bedienbar, und nach Wiederherstellung funktionieren die vorhandenen Steuerelemente.

Die nativen Regressionen kompilieren die unveränderten aktuellen Methoden aus den Produktionsdateien zusammen mit dem echten OAuth-Cache. OAuth-Endpunkte, Konten, Speicher und Energie-APIs werden durch künstliche Grenzen ersetzt. Der vollständige Xcode-Build prüft zusätzlich die tatsächlichen App-Klassen. Diese Tests verändern keine echten Konten, Schlüsselbünde oder Energieeinstellungen.

Die Linux-Auslassungen betreffen Mount-Prüfungen für Cold Storage mit `CAP_SYS_ADMIN` und SquashFS. Eine Prüfung mit echten Providerkonten, geschlossenem Worker-Deckel und ausgerolltem Produktionsstand steht außerhalb dieser lokalen Abnahme.

Alle damals geprüften geänderten Quelldateien sind mit SHA-256 in [verification.json](verification.json) erfasst. Die anschließende Integration und Live-Ausrollung mit eigenem Readback stehen in [Live-Ausrollung und Abnahme](rollout.md) und [live-verification.json](live-verification.json).

Die Textbelege enthalten die Ergebnisabschnitte der Logs. Die vollständigen Protokolle sind zusätzlich lokal archiviert; Pfade und SHA-256 stehen in `verification.json`.

## Prüfungen wiederholen

Aus dem Repository mit Node 22.22.2 sowie der lokalen Xcode-/Python-Toolchain:

```sh
node --test team-server/test/*.test.js scripts/*.test.mjs
swift test
python3 scripts/test-audit-native.py
python3 scripts/test-credential-storage.py
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/check_l10n.py
xcodebuild build -project Usage4Claude.xcodeproj -scheme Usage4Claude -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=''
xcodebuild build -project Usage4Claude.xcodeproj -scheme Usage4Claude -configuration Release -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=''
PLAYWRIGHT_MODULE=/absoluter/pfad/zu/playwright node scripts/review-planning.cjs /absoluter/ausgabeordner
```
