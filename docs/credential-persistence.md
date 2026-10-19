# Dauerhafte Zugangsdaten ohne wiederholte Schlüsselbundabfragen

Der Release-Speicher verwendet `PersistentCredentialVault`. Nach abgeschlossener
Einrichtung finden **keine Schlüsselbundzugriffe** mehr statt: weder beim Start
noch beim Speichern, Löschen, Erneuern eines Tokens oder bei fehlenden Konten.
Der Speicherort hängt nur von der Bundle-ID ab und bleibt bei App-Updates bestehen.
Debug-Builds verwenden weiterhin ihren getrennten `DEBUG_`-Speicher.

## Ablage und Schutz

Unter `~/Library/Application Support/<bundle-id>/` liegen:

- `credentials.vault`: AES-256-GCM-verschlüsselte Einträge, Modus `0600`.
- `credentials.key`: dauerhafter lokaler 32-Byte-Schlüssel, Modus `0600`.
- `credentials.ready`: Abschlussmarker für die einmalige Übernahme, Modus `0600`.

Das Verzeichnis hat Modus `0700`. Die Sicherheitsgrenze ist das macOS-Benutzerkonto.
Die Schlüsseldatei ist für Prozesse desselben Benutzers lesbar. Dies ersetzt bewusst
die appbezogene Schlüsselbund-Autorisierung; Verschlüsselung allein schützt hier
nicht vor einem bereits kompromittierten Benutzerkonto. Bei Backups müssen Tresor
und Schlüssel gemeinsam gesichert werden.

## Übernahme vorhandener Installationen

Beim ersten Start ohne abgeschlossene Übernahme liest die App den alten `vault-key`
und die noch fehlenden Alt-Einträge (einschließlich `fleetMonitoringAccount`). Dabei
kann macOS einmalig die Freigabe der bestehenden Einträge verlangen. Je nach alten
Zugriffsrechten können mehrere Einträge bei dieser einen Einrichtung zu bestätigen
sein. Danach wird der Schlüssel lokal gespeichert und die Übernahme abgeschlossen.
Ein verweigerter Import gilt nicht als abgeschlossene Einrichtung.

Alte Schlüsselbund-Einträge werden nicht geändert oder gelöscht. Bestehende
Tresorwerte haben Vorrang. Fehlender Zugriff, ein falscher Schlüssel oder beschädigte
Daten führen zu einem Fehler; die App ersetzt den Bestand nicht durch einen leeren
Tresor und fällt nicht bei jedem einzelnen Zugriff auf den Schlüsselbund zurück.
Ein unterbrochener Import behält seinen bereits gespeicherten Schlüssel und setzt
nur fehlende Übernahmen fort. Ein abgeschlossener Import übernimmt gelöschte
Zugangsdaten nach Neustarts nicht erneut aus alten Schlüsselbundkopien.

## Newsletter-Bridge

Der Installer übernimmt den Bridge-Token einmalig in
`~/Library/Application Support/Max Monitor/Newsletter Bridge/<TEAM-ID>/bridge-token`
(`0600`, Verzeichnis `0700`). Die generierte `run.sh` liest nur diese lokale Datei.
`--check` greift nicht auf den Schlüsselbund zu. Eine erneute Installation behält
den vorhandenen Token; ein fehlender oder ungültiger Token im laufenden Dienst
führt zu einem Fehler ohne Schlüsselbund-Fallback.

Bei vorhandenen Bridge-Diensten muss der aktualisierte Installer einmal auf dem
Bridge-Host ausgeführt werden, damit auch die bereits generierte `run.sh` ersetzt
wird. Die neue App muss über den normalen Releaseweg auf die betreffenden Macs
gelangen. Diese Codeänderung allein aktualisiert keine laufenden Installationen.

## Prüfung

`swift test` deckt Übernahme, Neustarts, Tokenrotation, gelöschte/fehlende Einträge,
Zugriffsverweigerung, falsche/fehlende Schlüssel, beschädigte Dateien und unterbrochene
Übernahmen ab. Nach abgeschlossener Einrichtung wirft der injizierte
Schlüsselbundleser in diesen Tests bei jedem unerwarteten Zugriff einen Fehler.

`bash scripts/test-credential-persistence.sh` prüft dieselbe Ablage mit getrennten
Prozessen und zwei unterschiedlichen ad-hoc-signierten Binaries.
`node --test scripts/monitor-bridge-credentials.test.mjs` prüft zusätzlich die
generierte Dienstdatei bei wiederholten Starts und fehlendem lokalem Token.

Ein echter macOS-Neustart und der flächige Rollout sind davon getrennte Prüfungen.

### Lokal verifiziert am 19.10.2026

- 200 Swift-Tests und 44 Bridge-Tests bestanden, ohne Fehler.
- Getrennte Prozesse und zwei unterschiedlich signierte Test-Binaries bestanden.
- Vollständiger Xcode-Release-Build erfolgreich.
- Die gebaute Release-App wurde unter der getrennten Test-Bundle-ID
  `de.ruegamersteiner.MaxMonitor.KeychainCheck` geprüft: erster Speicherzugriff,
  erneuter Prozessstart und geänderte Signatur behalten denselben lokalen Schlüssel.
- Das native Fenster wurde per Computer Use sichtbar geprüft; die App wurde regulär
  beendet und erneut geöffnet, ohne Schlüsselbunddialog. Keine echten Konten verbunden.
- Keine bestehende App-Installation, kein Worker und kein Bridge-Dienst aktualisiert;
  kein echter macOS-Neustart ausgeführt.

Die lokalen Protokolle und der maschinenlesbare Prüfstand liegen unter
`build/keychain-*.log` und `build/keychain-verification.json`.
