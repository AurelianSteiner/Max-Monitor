# Pink: Claude-Kontingente nach TLS-Abbruch erneut abrufen

## Diagnose

Am 22.10.2026 um 17:27:45 und 17:49:42 Europe/Berlin protokolliert Pinks
Max-Monitor-Prozess Fehler im OAuth-Usage-GET. CFNetwork meldet
`NSURLErrorDomain -1200`, darunter `-9816`, und im zugehörigen Verbindungsverlauf
`Connection reset by peer` während des TLS-Handshakes. Es wurden jeweils keine
HTTP-Anfrage- oder Antwortbytes übertragen. Der erste fehlschlagende Pfad war
IPv6; parallele IPv4-Verbindungsversuche wurden danach verworfen.

Die Logs belegen den Verbindungsabbruch auf dem Weg zum Claude-Endpunkt. Sie
identifizieren nicht, ob Anthropic, ein vorgelagertes Netzsystem oder ein
Zwischenknoten den Reset ausgelöst hat. Ein bestimmter Router oder ein dauerhaft
defektes IPv6 wird deshalb nicht als Ursache behauptet.

Direkte Prüfungen auf Pink erreichten `api.anthropic.com/api/oauth/usage` über
IPv4 und IPv6 in ungefähr 0,2 Sekunden. Beide meldeten Zertifikatsprüfung 0 und
HTTP 401, wie bei diesen ausdrücklich nicht authentifizierten Netzwerkproben
erwartet. Systemzeit und Route waren plausibel, ein Systemproxy war nicht
konfiguriert. Ein Zertifikats- oder Accountwechsel wurde nicht vorgenommen.

Der bisherige Abruf meldete jeden Transportfehler sofort an das Monitoring.
`FleetMonitoringManager` behält dann die letzte erfolgreiche Messung und erhöht
das Abrufintervall von fünf auf zehn, zwanzig und maximal dreißig Minuten.
Dadurch blieb die Anzeige nach kurzen Verbindungsabbrüchen lange unbestätigt.
Eine erfolgreiche automatische Messung um 18:00:37 erfolgte bereits vor der
Reparatur; sie ist kein Nachweis für den neuen Code.

## Korrektur

Nur der lesende Claude-OAuth-Usage-GET wird nach TLS-Transportfehler,
Verbindungsverlust oder Timeout einmal wiederholt. Vor dem zweiten Versuch
erzwingt `URLSession.flush` eine neue TCP-Verbindung. Danach greifen die
bisherigen Fehler- und Backoff-Regeln unverändert. Zertifikatsfehler, Abbruch,
HTTP-Antworten einschließlich 401/429 sowie POST-Anfragen werden von dieser
Transportkorrektur nicht erneut ausgeführt. OAuth-Token-Erneuerungen und
Modellanfragen verwenden diesen Pfad nicht.

Apple beschreibt `-9816` als Ende der Verbindung ohne TLS-Benachrichtigung:
[errSSLClosedNoNotify](https://developer.apple.com/documentation/security/errsslclosednonotify).
Die dokumentierte Wirkung von
[URLSession.flush](https://developer.apple.com/documentation/foundation/urlsession/flush(completionhandler:))
ist eine neue TCP-Verbindung für folgende Anfragen; laufende Aufgaben werden
dabei nicht abgebrochen.

## Prüfung und Bereitstellung

- Acht gezielte Transporttests bestanden, einschließlich Erholung nach dem
  ersten Fehler, Begrenzung auf zwei Versuche und Erhalt der Zertifikatsfehler.
- Alle 216 Swift-Tests bestanden.
- Vollständiger App-Build für arm64 und x86_64 erfolgreich; Signaturprüfung
  `codesign --verify --deep --strict` erfolgreich.
- Grundlage ist der native Quellstand von Pinks tatsächlich installiertem
  2.16.3-Artefakt, `ea2aed27bad0eca6af66b77212f1f36635c72a69`.
- Die Pink-Version heißt `2.16.3+pink-tls1`. Der numerische Release-Teil bleibt
  kompatibel mit der vorhandenen Wartung, damit diese den Reparaturbuild nicht
  allein wegen einer Versionsabweichung wieder durch 2.16.3 ersetzt.
- Paket-SHA256:
  `a0a74e218d1ddcb8f0c1d213f589550ad18b85c33dbcf7ea8316a46b34c059a4`.
- Patch-Digest im App-Bundle:
  `93b65a06943f34ef8d8242ba225affa1e8778cc7df26ceea43d9d41eb0dc189d`.

Die Bereitstellung betrifft ausschließlich die Monitoring-App auf Pink. Der
vorhandene Installer erhält Gerätebindung und Kontoeinstellungen. Während des
Austauschs wird nur der Monitor-Abgleich kurz durch dessen vorhandenen Lock
serialisiert. Newsletter-Dienst, Worker-Beobachter, Wartungstunnel und
unabhängiger Wachschutz werden nicht angehalten. Ihre Prozessidentitäten werden
vorher und nachher verglichen.

Eine Kopie der vorherigen App und des Installationsbelegs liegt auf Pink unter
`~/.local/share/max-monitor-repairs/pink-tls-20261022/before/`. Lokale Prüfbelege
liegen im Reparatur-Worktree unter `build/`; sie enthalten keine Provider-Tokens.

Die Live-Abnahme wird nach dem Austausch ergänzt.
