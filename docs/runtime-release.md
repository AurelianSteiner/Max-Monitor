# Nachvollziehbare Runtime-Ausrollung

`Config/runtime-release-files.json` benennt die ausgeführten Relay-, Queue- und
Wartungsquellen einschließlich der dort aufgeführten statischen Dashboard-Dateien.
Die native App, private Konfiguration, Datenbanken und vorhandene zusätzliche
Betriebshilfen gehören nicht zu dieser gezielten Ausrollung.

Der geprüfte Commit muss sauber und exakt als `origin/main` veröffentlicht sein.
Die Nutzdaten werden mit `git show <Commit>:<Datei>` gelesen. Der Releaseweg nutzt
den vorhandenen Hub-Zugang von `setup-mac-monitor.mjs`/`worker-remote.mjs`.

```bash
node scripts/release-runtime.mjs --baseline /private/source-inventory.json --output /private/preflight.json --newsletter-root /private/worker-main
node scripts/release-runtime.mjs --baseline /private/source-inventory.json --output /private/receipt.json --newsletter-root /private/worker-main --install
```

`--newsletter-root` ist Pflicht: ein sauberer Checkout exakt auf dem veröffentlichten
`main` von AI Newsletter Creation. Jeder Release erneuert damit unter
`/opt/max-monitor/newsletter-source/` die Worker-Regeln, die die Queue-Bridge lädt
(Require-Abschluss von `upload-policy.js`, `test-workspace.js`, `slack-kanaele.js`,
`workflow-cutover.json` und Einstiegspunkten, dazu `config/monitor-channels.json`),
niemals `config/worker.local.json`. Die Quittung nennt `newsletterSourceRevision`.
Anlass (Prinz 12451cu4101, 29.10.2026): Die Kopie stammte vom 17.10. und hielt Prinz
noch für einen manuellen Upload; die Queue verbarg den blockierten automatischen Upload.
Das Inventar enthält daher auch diese Pfade, neue Dateien mit `"sha256": null`.

Das lesend aufgenommene Inventar enthält `files: { "scripts/datei.mjs": {
"sha256": "…" } }` für die tatsächlich vorhandenen Quellen und zusätzlich zu
erhaltenden Helfer. Jede Abweichung seit dieser Aufnahme bricht vor der Mutation
ab. Der Installer prüft dieselben Basishashes nach der Syntaxprüfung noch einmal.
Bei Drift erst die neue Quelle prüfen und einen neuen Baseline-Beleg aufnehmen;
niemals lediglich den erwarteten Hash passend machen.

Gezielter Release und regulärer Hub-Installer verwenden
`/run/lock/max-monitor-code-release.lock`. Der gezielte Installer sichert die
vorherigen Quellen und Quittung, ersetzt nur Manifestdateien, startet ausschließlich
die zuvor aktiven Monitor-Dienste und prüft sämtliche Quellhashes zurück. Die
Quittung `relay-release.json` enthält Commit und tatsächliche Hashes aller
Manifestdateien. Unbekannte Helfer bleiben erhalten und werden separat gehasht. Bei einem
Fehler wird nur die eigene, noch unverändert vorliegende Mutation zurückgenommen.

Der reguläre Installer schreibt ebenfalls eine neue Quittung für seine Quellen.
Fehlt ihm ein sauberer Git-Quellstand, steht dort ausdrücklich
`verifiedSource: false`/`sourceRevision: null`; ein alter Release-Marker wird nicht
weiter als Nachweis ausgegeben. Seine Installationsliste enthält jetzt auch den
Integrationsvertrag, Worker-Identitäten und das Blockerkontext-Modul.

Die Ausrollung startet weder Newsletter-Worker noch Produktionsaufträge und führt
keine ClickUp-/FileStage-Schreibtests aus. Anschließend Dienst, frischen regulären
Queue-Snapshot, alle Manifesthashes und die tatsächlichen Verträge der acht Worker
lesend abnehmen. Enthaltene statische Dashboard-Dateien werden aus demselben
Commit veröffentlicht; die native App wird hier weder gebaut noch ausgetauscht.
